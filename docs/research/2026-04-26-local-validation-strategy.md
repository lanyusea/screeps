# Local Validation Strategy for Screeps MVP Economy Loop

Date: 2026-04-26

## Context

The first MVP economy-loop base now exists in `prod`. It is still not validated in a real Screeps private server. An earlier `hermes doctor` pass showed Docker was not installed in the worker environment; a later follow-up resolved this, and Docker Engine `29.1.3` plus Docker Compose v2 `v2.40.3` are now available in both main and delegated-worker contexts.

Therefore, validation is staged:

1. deterministic mock lifecycle tests now
2. private server smoke tests later once Docker/private-server runtime is available
3. staged MMO deployment only after local validation

## Current validation layer implemented

A deterministic Jest lifecycle test was added:

- `prod/test/mvpEconomyLifecycle.test.ts`

It covers the current minimum economy path:

1. owned room + idle spawn below target workers plans a worker spawn
2. empty worker receives harvest task
3. full worker transitions from harvest to transfer/refill
4. worker with transfer task transfers energy to spawn

This does not replace a real Screeps simulation, but it locks down the most important state-machine behavior that earlier reviewer feedback identified as a blocker.

## Verification

Command:

```bash
cd prod
npm test -- mvpEconomyLifecycle.test.ts
npm run typecheck
```

Result:

- lifecycle test passed
- typecheck passed

Full project verification should still run before each meaningful commit:

```bash
cd prod
npm run typecheck
npm test
npm run build
```

## Next validation layer: deterministic tick integration

Candidate package:

- `screeps-server-mockup`

Goal:

- run a controlled room for N ticks
- verify worker spawning, harvesting, spawn refill, upgrading/building progression
- validate memory survives across ticks

Risks:

- native/private-server dependencies can be heavy
- package behavior may lag official MMO
- still not equivalent to public shard behavior

## Next validation layer: Dockerized private server smoke test

Preferred path remains Dockerized `screeps-launcher` because the official `screeps` npm package currently expects Node 22+ while the current environment has Node 18.

Required items:

- Docker / Docker Compose availability
- Steam Web API key
- `screeps-launcher` config
- `screepsmod-auth` if uploading via auth-backed tooling
- optional MongoDB/Redis setup if using `screepsmod-mongo`

Smoke checklist:

1. private server starts
2. client can connect
3. bot code uploads or is injected
4. `main.loop` runs without fatal exception
5. first worker spawn works
6. worker harvest/refill/upgrade/build flow progresses for several hundred ticks
7. memory cleanup works after creep death
8. console/log output is readable

## Current conclusion

The MVP economy loop has passed deterministic unit/lifecycle validation, but it is not yet private-server validated. The next hard validation milestone is either `screeps-server-mockup` integration or Dockerized private-server smoke testing.
