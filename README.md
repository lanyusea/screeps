# Screeps Autonomous Competition Bot

<p align="center">
  <img src="docs/assets/screeps-community-logo.png" alt="Screeps autonomous coding assistant logo" width="280">
</p>

<p align="center">
  <strong>An autonomous, test-driven Screeps: World operations stack for long-running territorial expansion, resource scaling, and competitive combat.</strong>
</p>

<p align="center">
  <a href="https://discord.gg/XenFZG9bCE">Join the Discord community</a>
</p>

## Project overview

This repository develops and operates a long-running autonomous bot for [Screeps: World](https://screeps.com/), a persistent MMO programming game in which code controls every creep, structure, room decision, market action, and defensive response on each game tick. The project is structured as a complete autonomous operations system rather than a standalone script: it combines production bot code, deterministic validation, deployment runbooks, runtime monitoring, research notes, and GitHub/Discord-based coordination.

The engineering goal is to build a bot that can survive continuously, expand deliberately, convert territory into durable economic value, and eventually sustain effective defensive and offensive operations on competition-style maps. Decisions in this repository are evaluated against that ordered gameplay objective:

1. **Territorial control first** — claim, reserve, hold, defend, and coordinate a large footprint of rooms.
2. **Resource scale second** — convert territory into reliable energy, minerals, logistics capacity, storage, infrastructure, and market-ready value.
3. **Enemy kills third** — build combat capability that removes threats and wins fights once the economy can sustain expansion and losses.

Combat is therefore important, but it is treated as a capability that serves territorial and economic control rather than as an isolated metric.

## Community and collaboration

The project is being prepared for broader community visibility. Community members can follow progress, read staged project posts, discuss Screeps automation ideas, and observe the bot’s roadmap as the system evolves.

- **Discord invite:** <https://discord.gg/XenFZG9bCE>
- **Primary public artifact:** this GitHub repository and its documentation under `docs/`
- **Development model:** focused worktree branches, pull requests, automated checks, and documented operational evidence

Contributions, questions, and architecture discussions are welcome as the repository matures. Production behavior is still gated carefully because Screeps bots operate in a persistent shared world and unsafe changes can have lasting gameplay consequences.

## System scope

The project includes the following major layers:

- **Production Screeps runtime** — TypeScript bot code exported as a Screeps-compatible `loop`, with memory/schema discipline, kernel orchestration, spawn/economy behavior, creep task execution, and runtime telemetry.
- **Validation pipeline** — typechecking, Jest tests, bundling, private-server smoke harnesses, and release evidence before official MMO deployment.
- **Operations and monitoring** — room snapshots, alerting, runtime summaries, Discord reporting, active-work state, and recovery notes for autonomous development.
- **Research and planning** — documented Screeps API findings, development-chain decisions, private-server strategy, architecture references, and roadmap rationale.
- **Governance and review** — topic branches, pull requests, GitHub Project tracking, CI requirements, automated review gates, and explicit acceptance evidence.

## Roadmap and current goals

The detailed live roadmap is maintained in [`docs/ops/roadmap.md`](docs/ops/roadmap.md), and the canonical project vision is maintained in [`docs/ops/project-vision.md`](docs/ops/project-vision.md). At a high level, current work is organized around these domains:

### 1. Agent OS and project visibility

Keep autonomous development observable, recoverable, and accountable. This domain covers Discord reporting, scheduled continuation workers, P0 operations monitoring, roadmap snapshots, active-work state, and process notes.

### 2. Engineering governance

Make meaningful changes reviewable, reproducible, and safe to merge. This domain covers git worktrees, topic branches, pull requests, CI, branch protection, review gates, and the execution boundary between orchestration and production-code implementation.

### 3. Bot capability foundation

Establish a stable single-room bot that can survive and operate without deadlocks. Implemented foundations include the TypeScript/Jest production skeleton, exported Screeps `loop`, memory initialization, dead-creep cleanup, colony detection, worker spawn planning, worker body selection, and harvest/transfer/build/upgrade behavior.

### 4. Private-server validation

Validate real Screeps runtime behavior before risking official MMO deployment. The private-server path should prove that the bot can upload, place a spawn, run ticks, create creeps, exercise economy behavior, and produce a redacted report.

### 5. Runtime monitoring and alerting

Make official/private runtime state visible without noisy spam. This domain covers live-token room snapshots, runtime-summary images, hostile/damage alert detection, no-alert silence behavior, and warm editorial status visuals.

### 6. Official MMO deployment

Deploy to the official Screeps MMO only after release-quality evidence exists. The current official target is branch `main`, shard `shardX`, room `E48S28`, with deployment gated by deterministic tests, build verification, private-server smoke evidence, safe token handling, and post-deploy observation.

Runbook: `docs/ops/official-mmo-deploy.md`.

### 7. Expansion, resources, and combat

Move beyond single-room survival toward the competition vision: expansion scouting, room scoring, claim/reserve planning, remote-room logistics, road/container/storage/repair systems, minerals and market readiness, defensive telemetry, and eventually coordinated combat.

## Repository structure

| Path | Purpose |
| --- | --- |
| `prod/` | Runnable Screeps bot: TypeScript source, tests, build config, and bundled deploy artifact. |
| `scripts/` | Local operations, validation, monitoring, and rendering scripts. |
| `docs/` | Durable project documentation by lane: `docs/ops/` for runbooks, coordination, and roadmap; `docs/research/` for findings; `docs/process/` for decision trails and recovery notes; plus shared docs assets. |
| `.github/` | GitHub Actions and repository automation configuration. |
| `.gemini/` | Gemini/code-review configuration. |

Most day-to-day production work happens under `prod/`, while roadmap and operations context lives under `docs/`. Generated artifacts such as `prod/dist/main.js` should be produced by the build process, not hand-edited.

## Development workflow

- Do not commit directly on `main`; use a topic branch in a git worktree.
- Keep changes focused, reviewable, and PR-ready.
- For production code under `prod/`, run:

```bash
cd prod
npm run typecheck
npm test -- --runInBand
npm run build
```

- Keep secrets out of git and out of Discord. Screeps auth tokens, Steam keys, private-server credentials, and local selectors belong only in ignored local configuration.

## Security and operational safety

This repository may interact with persistent Screeps worlds and authenticated APIs. Do not commit tokens, passwords, Steam keys, private-server credentials, raw authorization headers, or uploaded module contents. Deployment and live-runtime actions should be documented, reversible where practical, and supported by verification evidence.
