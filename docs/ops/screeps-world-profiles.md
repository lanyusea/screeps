# Screeps World Profiles

Date: 2026-05-15

This document defines the durable profile contract for official Screeps: World automation. The persistent MMO profile remains the default. Seasonal World support is explicit opt-in and must never change persistent `main / shardX / W3N9` behavior unless a later owner decision says so.

## URL Contract

Scripts that talk to the official Screeps service must receive a world root:

- Persistent MMO: `https://screeps.com`
- Seasonal World: `https://screeps.com/season`

Do not pass API roots such as `https://screeps.com/api` or `https://screeps.com/season/api`. Scripts append endpoint paths such as `/api/user/code` themselves.

## Profiles

| Field | Persistent MMO default | Seasonal current-season smoke |
| --- | --- | --- |
| Purpose | Durable production bot operation | Owner-approved current-season smoke only, not a ranking push |
| World root | `https://screeps.com` | `https://screeps.com/season` |
| Code branch | `main` | `seasonal-smoke` or `seasonal-main`; final branch name pending authenticated discovery |
| Shard | `shardX` | `shardSeason` |
| Room | `W3N9` | `TBD` until authenticated discovery |
| Deploy artifact | `prod/dist/main.js` | `prod/dist/main.js` built from the same verified source |
| Deploy evidence | `runtime-artifacts/official-screeps-deploy/` | `runtime-artifacts/seasonal/official-screeps-deploy/` |
| Routine monitor artifacts | `runtime-artifacts/screeps-monitor/` | `runtime-artifacts/seasonal/screeps-monitor/` |
| Runtime-summary console artifacts | `runtime-artifacts/runtime-summary-console/` | `runtime-artifacts/seasonal/runtime-summary-console/` |
| Runtime monitor state | `/root/.hermes/screeps-runtime-monitor/state.json` | `/root/.hermes/screeps-seasonal-runtime-monitor/state.json` |
| Runtime monitor terrain cache | `/root/.hermes/screeps-runtime-monitor/terrain-cache/` | `/root/.hermes/screeps-seasonal-runtime-monitor/terrain-cache/` |
| Deploy health-gate state | `runtime-artifacts/official-screeps-deploy/postdeploy-monitor-state.json` | `runtime-artifacts/seasonal/official-screeps-deploy/postdeploy-monitor-state.json` |
| Recovery authorization | W3N9 autonomous recovery rules in `docs/ops/rules-registry.md` | No destructive recovery, respawn, or autonomous placement authorization unless explicitly approved for Seasonal |

## Persistent MMO Invariant

The following defaults are part of the persistent production contract:

- `SCREEPS_API_URL=https://screeps.com`
- `SCREEPS_BRANCH=main`
- `SCREEPS_SHARD=shardX`
- `SCREEPS_ROOM=W3N9`
- Deployment evidence remains under `runtime-artifacts/official-screeps-deploy/`.
- Runtime monitor artifacts remain under `runtime-artifacts/screeps-monitor/`.
- Runtime monitor state/cache remain under `/root/.hermes/screeps-runtime-monitor/`.

Seasonal commands must set their Seasonal world root, selectors, and state/cache/artifact paths explicitly. They must not rely on persistent defaults.

`scripts/screeps-runtime-monitor.py` live subcommands and `scripts/screeps_runtime_summary_console_capture.py` also accept `SCREEPS_WORLD_PROFILE` or `--world-profile` with values `persistent` or `seasonal`. Omitted or `persistent` preserves the defaults above. Explicit `seasonal` switches only default monitor/capture paths, runtime-summary paths, `SCREEPS_API_URL` fallback, and `SCREEPS_SHARD` fallback to Seasonal values; existing CLI arguments and env overrides such as `SCREEPS_API_URL`, `SCREEPS_SHARD`, `SCREEPS_MONITOR_STATE_FILE`, `SCREEPS_MONITOR_CACHE_DIR`, `SCREEPS_RUNTIME_SUMMARY_DIR`, and `SCREEPS_RUNTIME_SUMMARY_CONSOLE_OUT_DIR` still win.

## Seasonal Smoke Contract

The current Seasonal goal is a smoke test only:

1. Discover the authenticated Seasonal room target without writing to the persistent MMO.
2. Use `https://screeps.com/season` as the dry-run world root and `shardSeason` as the shard selector.
3. Use an isolated Seasonal branch, pending final choice between `seasonal-smoke` and `seasonal-main`.
4. Write evidence and monitor outputs only under `runtime-artifacts/seasonal/...` and `/root/.hermes/screeps-seasonal-runtime-monitor/...`.
5. Keep persistent deploy, monitor, cron, and recovery automation unchanged.

`scripts/screeps_official_deploy.py` accepts the Seasonal world root for dry-run planning only. Seasonal live deploy is not enabled; its `--deploy` mode remains restricted to the persistent MMO root, `https://screeps.com`, until monitor/evidence/state/cache isolation is complete in a later slice.

## No-Impact Verification

Every Seasonal-related change or smoke step must include persistent MMO no-impact verification:

1. Confirm the command line or environment uses a world root, not an API root.
2. Confirm persistent selectors are unchanged when running persistent checks: `https://screeps.com`, `main`, `shardX`, `W3N9`.
3. Confirm Seasonal checks use isolated selectors and paths: `https://screeps.com/season`, `shardSeason`, `runtime-artifacts/seasonal/...`, and `/root/.hermes/screeps-seasonal-runtime-monitor/...`.
4. Run the deploy helper dry run for the persistent profile after script changes:

   ```bash
   python3 scripts/screeps_official_deploy.py \
     --dry-run \
     --api-url https://screeps.com \
     --branch main \
     --shard shardX \
     --room W3N9
   ```

5. Run the narrow script tests and production build/test gate required by the task or PR.
6. Before any live Seasonal write, verify no command will touch persistent artifact/state/cache paths and no W3N9 recovery or respawn authorization is being applied to Seasonal.
