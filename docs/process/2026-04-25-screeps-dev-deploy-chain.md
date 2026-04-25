# Screeps Dev / Test / Deploy Process Note

Date: 2026-04-25

## What changed

I turned the initial Screeps research pass into a practical development chain recommendation:
TypeScript source, Rollup-style bundling, private-server testing, and authenticated public deployment.

## Why it changed

The goal was not just to learn the API surface.
We needed a workflow that is realistic for ongoing bot development, easy to document, and easy to repeat later in a blog post.

A simple in-game editor workflow is fine for tiny experiments, but it does not scale well once the codebase grows, the architecture becomes modular, and private-server testing becomes part of the loop.

## What I verified

From the official Screeps docs:

- scripts use `require()` and `module.exports`
- `lodash` is embedded
- external commits require an auth token from account settings
- `grunt-screeps` is a supported upload path
- the code API can be used directly at `/api/user/code`

From community references:

- `screeps-typescript-starter` uses Rollup for compile/upload
- `typed-screeps` is the maintained TS declaration package
- `Overmind` is a mature TS + Rollup reference architecture
- `screeps-launcher` is the strongest default for private-server setup
- the launcher can run with `config.yml`, mods, bots, CLI access, and Mongo/Redis-backed persistence
- Docker-based private-server variants exist when image-build-time setup is preferred

## What surprised me

1. Screeps is more infrastructure-heavy than it first appears.
   The game is still a programming puzzle, but the practical workflow quickly becomes a small software delivery pipeline.

2. TypeScript is not just a nice-to-have.
   The official docs are JS-like, but the community ecosystem around Screeps clearly assumes that larger bots will want types, bundling, and a build step.

3. Local testing is a first-class part of the Screeps culture.
   The private-server stack is not a side project; it is a normal development path.

## What I would do differently next time

I would standardize the repo’s dev loop earlier around three explicit layers:

- source tree
- build artifact
- deployment target

That separation makes it easier to reason about what failed:

- code bug
- build bug
- deploy bug
- server config bug

## Blog-worthy takeaway

Screeps is not really “game scripting” in the casual sense.
It is closer to running a small autonomous service with two environments:

- a local/private simulation environment
- a live public MMO environment

Once you see it that way, the right workflow becomes obvious: write maintainable source, build a deployable artifact, test locally, then promote to production.

## Reasoning trail

1. Start from the official docs to confirm the runtime model.
2. Use third-party docs to see what the community actually standardizes on.
3. Prefer the community path that minimizes friction for repeat development.
4. Preserve the decision path in a blog-ready note instead of burying it in chat.

## Useful references

- Official modules docs
- Official external commit docs
- Official third-party tools page
- Screeps wiki getting started guide
- Overmind README
- Screeps TypeScript starter README
- typed-screeps README
- screeps-launcher README
