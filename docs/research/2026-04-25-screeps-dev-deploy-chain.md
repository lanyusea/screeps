# Screeps Local Development, Testing, and Deployment Chain

Date: 2026-04-25

## Executive summary

The best current Screeps: World workflow is a TypeScript-first source tree that bundles to a single JavaScript upload artifact, backed by a private server for local testing and an authenticated external commit path for deployment to the public MMO.

In practice, that means:

1. Write source in TypeScript or JavaScript modules.
2. Bundle/transpile to one `main.js` artifact for upload.
3. Run local tests against a private server or simulation environment.
4. Push to the official world server with an auth-token-backed upload tool.

JavaScript remains the native runtime language, but TypeScript is the better default for a non-trivial bot because the community ecosystem around Screeps strongly favors it.

## What the official docs confirm

### Module model

The official Screeps docs describe a Node-like module system using `require()` and `module.exports`.
They also document embedded `lodash` support.
That makes Screeps feel closer to a Node runtime than to a browser script sandbox.

### External deployment

The official docs for external commits say you need an auth token from account settings to synchronize code from outside the game.
They document two supported upload approaches:

- `grunt-screeps`
- direct API access to `https://screeps.com/api/user/code`

That API accepts `GET` and `POST` and stores code as a JSON `modules` object.

### Third-party language support

The official third-party tools page says external transpilers can be used to write AI in other languages.
It explicitly lists community starter projects for TypeScript, Python, Rust, and Kotlin.
It also points to `typed-screeps` as the TypeScript declaration package.

### Local/private server support

The Screeps wiki says the persistent world is separate from the private server workflow.
Private servers are the normal way to do local testing before pushing to the MMO.

## Current best workflow recommendation

### 1) Language choice: TypeScript over pure JavaScript

**Recommendation:** use TypeScript unless the bot is still in a tiny prototype phase.

Why:

- The official runtime is still JS-like, but the community tooling is mature for TS.
- `typed-screeps` provides actively maintained declarations.
- `screeps-typescript-starter` is a ready-made TS starting point.
- Bigger Screeps bots tend to become architecture-heavy; TS helps keep that maintainable.

When JavaScript is better:

- throwaway prototypes
- tiny experiments
- direct in-game editor work

### 2) Module and bundling style: source modules, single deploy bundle

**Recommendation:** keep source modular, but compile to one upload bundle.

Why:

- Screeps itself accepts `require()`-style modules.
- A single production bundle simplifies deployment and reduces upload friction.
- Overmind, a mature reference bot, uses TypeScript plus Rollup.
- The Screeps TypeScript starter also uses Rollup for compile/upload.

Practical shape:

- `src/` for source modules
- `dist/main.js` or equivalent as the only deployed artifact
- optional build steps for source maps, linting, and tests

### 3) Local development/testing: private server first

**Recommendation:** treat a private server as the main local test loop.

Two good community paths exist:

- `screepers/screeps-launcher`
- `jomik/screeps-server` (Docker-oriented alternative)

The launcher is the more straightforward default because it handles installation and setup, supports `config.yml`, can manage mods and bots, provides a CLI, and supports backup/restore. If using the Mongo-backed setup, it requires MongoDB and Redis and a one-time `system.resetAllData()` initialization.

For a Docker-first environment, the alternative server image is appealing if you want setup done at image build time instead of at runtime.

### 4) Deployment: auth-token-backed external commit

**Recommendation:** deploy through a scripted external commit path instead of manual in-game copying.

Good options:

- `grunt-screeps` for a classic upload workflow
- direct API access for custom automation
- project-specific rollup/webpack/esbuild scripts that end in a code sync step

For public MMO deployment, the important part is that the tool is authenticated and writes to the code API.
For private-server deployment, use the private server’s own auth/mod setup and push the same built artifact there.

## Manual setup required

These are the human-owned setup steps that are hard to eliminate:

- Screeps account and auth token creation
- shard selection and spawn placement on the public world
- `screeps.json` or equivalent deployment credentials for public sync
- private server `config.yml`
- mods list, especially `screepsmod-auth`
- Steam API key for launcher-based server installs
- MongoDB and Redis if using the Mongo-backed private server stack
- one-time DB initialization with `system.resetAllData()` when required
- deciding whether the local server will run directly, under Docker, or via Docker Compose

## Best-fit workflow for this repository

If we want a workflow that scales without becoming overengineered, the best fit is:

- **TypeScript source** with typed Screeps declarations
- **Rollup-based bundle** to a single `main.js`
- **Launcher-based private server** for local testing
- **Scripted external commit** for public deployment
- **Docs-first process notes** so infra decisions stay reproducible

That gives us one source tree, one build artifact, and two deployment targets.

## Practical checklist

### Local loop

- edit source
- run build
- sync to private server
- inspect logs and runtime behavior
- iterate until stable

### Release loop

- run lint/tests/build
- verify private-server behavior
- upload to public MMO via auth-token-backed sync
- record deployment in process notes

## Sources

- https://docs.screeps.com/modules.html
- https://docs.screeps.com/commit.html
- https://docs.screeps.com/third-party.html
- https://wiki.screepspl.us/Getting_Started/
- https://raw.githubusercontent.com/bencbartlett/overmind/master/README.md
- https://raw.githubusercontent.com/screepers/screeps-typescript-starter/master/README.md
- https://raw.githubusercontent.com/screepers/typed-screeps/master/README.md
- https://raw.githubusercontent.com/screepers/screeps-launcher/master/README.md
- https://raw.githubusercontent.com/jomik/screeps-server/master/README.md
