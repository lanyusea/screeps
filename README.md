# Screeps Competition Bot

This repository builds and operates an autonomous Screeps: World bot. Screeps is a persistent MMO programming game: every room, creep, structure, defense, expansion, and market action is controlled by code running once per game tick. The project is therefore not just a collection of scripts; it is an attempt to build a reliable long-running game-playing system that can survive, expand, extract value from territory, and eventually fight effectively on competition-style maps.

## Project background and vision

The project vision is to develop a Screeps system that can win by compounding control over the map. In priority order, the bot should achieve:

1. **Enough large territory** — claim, reserve, hold, defend, and coordinate a large footprint of rooms.
2. **Enough resources across categories** — convert territory into durable energy, minerals, infrastructure, logistics capacity, storage, and market-ready value.
3. **Enough enemy kills** — develop defensive and offensive combat capability that removes threats and wins fights, after the economy can sustain expansion and losses.

That ordering is intentional. Combat is important, but it should serve territorial and economic control rather than become an isolated optimization target. Roadmap choices are evaluated against this chain:

```text
survive reliably → expand territory → scale resources → defend/attack effectively → optimize kills
```

The system we want is therefore a full autonomous operations stack, not only a creep script:

- a tested Screeps runtime kernel that can make safe decisions every tick;
- memory/schema discipline so long-running state survives code changes;
- economy, logistics, expansion, defense, and combat planners that scale from one room to many rooms;
- private-server and deterministic validation so risky behavior is caught before official MMO deployment;
- runtime monitoring and Discord reporting so failures, attacks, and roadmap progress remain visible.

## Roadmap and current goals

The roadmap is organized around the major capabilities needed to reach the vision. The detailed live roadmap is maintained in [`docs/ops/roadmap.md`](docs/ops/roadmap.md); the canonical vision is in [`docs/ops/project-vision.md`](docs/ops/project-vision.md).

### 1. Agent OS and project visibility

Goal: keep autonomous development observable and recoverable.

This domain covers Discord reporting, scheduled continuation workers, P0 operations monitoring, roadmap snapshots, active-work state, and process notes. It exists so long-running autonomous work does not disappear into silent background sessions and so future agents can recover context quickly.

### 2. Engineering governance

Goal: make every meaningful change reviewable, reproducible, and safe to merge.

This domain covers git worktrees, topic branches, pull requests, CI, review gates, branch protection, and Codex/Hermes execution boundaries. Production code changes under `prod/` are owned by Codex-driven implementation, while Hermes orchestrates planning, verification, documentation, and merge workflow.

### 3. Bot capability foundation

Goal: establish a stable single-room bot that can survive and operate without deadlocks.

Implemented foundations include the TypeScript/Jest production skeleton, exported Screeps `loop`, memory initialization, dead-creep cleanup, colony detection, worker spawn planning, worker body selection, and harvest/transfer/build/upgrade behavior. Current hardening focuses on deterministic fallbacks, worker replacement, emergency recovery, busy-spawn retries, and runtime-summary telemetry.

### 4. Private-server validation

Goal: validate real Screeps runtime behavior before risking official MMO deployment.

This domain uses a pinned Dockerized Screeps private-server path and a reusable smoke harness. The validation target is not merely “server starts”; the bot must upload, place a spawn, run ticks, create creeps, and exercise economy behavior in a real runtime loop while producing a redacted report that is safe to commit or discuss.

### 5. Runtime monitoring and alerting

Goal: make the official/private runtime observable in Discord.

This domain covers live-token room snapshots, runtime-summary images, alert detection, hostile/damage monitoring, no-alert silence behavior, and warm editorial status visuals. Monitoring should show owned-room state and escalate only actionable failures or attacks.

### 6. Official MMO deployment

Goal: deploy to Screeps official MMO only after release-quality evidence exists.

The current official target is branch `main`, shard `shardX`, room `E48S28`. Deployment is gated by deterministic tests, build verification, private-server smoke evidence, safe token handling, and post-deploy observation. Official MMO work should remain reversible and should never print or commit secrets.

### 7. Expansion, resources, and combat roadmap

Goal: move beyond single-room survival toward the actual competition vision.

After the current validation and monitoring gates are stable, the next strategic product work should prioritize:

- expansion scouting and room scoring;
- claim/reserve planning and remote-room logistics;
- road, container, storage, repair, and hauling systems that make territory productive;
- mineral and market readiness once the economy supports it;
- tower/rampart defense and hostile-intent telemetry;
- coordinated combat only after the economy can replace losses and sustain operations.

## Repository structure

The repository is intentionally split by responsibility:

| Path | Purpose |
| --- | --- |
| `prod/` | Runnable Screeps bot: TypeScript source, tests, build config, and bundled deploy artifact. |
| `scripts/` | Local operations, validation, monitoring, and rendering scripts. |
| `docs/` | Durable project documentation: vision, roadmap, runbooks, research notes, and process history. |
| `.github/` | GitHub Actions and repository automation configuration. |
| `.gemini/` | Gemini/code-review configuration. |

Most day-to-day production work happens under `prod/`, while roadmap and operations context lives under `docs/`. Generated artifacts such as `prod/dist/main.js` should be produced by the build process, not hand-edited.

## Development workflow

- Do not commit directly on `main`; use a topic branch in a git worktree.
- Keep changes focused and PR-ready.
- For production code under `prod/`, run:

```bash
cd prod
npm run typecheck
npm test -- --runInBand
npm run build
```

- Keep secrets out of git and out of Discord. Screeps auth tokens, Steam keys, and private-server credentials belong only in ignored local configuration.
