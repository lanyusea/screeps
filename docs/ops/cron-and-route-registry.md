# Screeps Cron and Route Registry

Last updated: 2026-05-01
Tracking issue: https://github.com/lanyusea/screeps/issues/427

This registry keeps the minimum cron/channel contract in one place. Cron prompts may embed short self-contained summaries, but their target/cadence/route expectations must match this file.

## Current target

- Official target: `main / shardX / E26S49`
- Old room references (`E48S28`, `E48S29`) are historical/superseded unless explicitly retargeted by the owner.

## Discord routes

| Purpose | Target | Notes |
| --- | --- | --- |
| Owner command / main thread | current Discord thread/home | Main-agent command and owner-facing summary surface. |
| Rules archive | `discord:1499621566164504766` | Final rules standards are archived here. |
| Roadmap/image sync | `discord:1497586803841040504` | Domain/roadmap visual sync target requested by owner. |
| Task queue | `discord:#task-queue` | Continuation/RL scheduling and active task state. |
| Research notes | `discord:#research-notes` | Factual findings and RL/research progress. |
| Dev log | `discord:#dev-log` | Implementation, verification, commits, files changed. |
| Roadmap | `discord:#roadmap` | Roadmap snapshots and Pages/report updates. |
| Runtime summary | `discord:1497588267057680385` | Routine room summary images/reports. |
| Runtime alerts | `discord:1497588512436785284` | P0 runtime alert/tactical response. |
| P0 operations | `discord:1497820688843800776` | Owner-action and autonomous-system health blockers. |
| Gameplay decisions/archive | `discord:1497586175580311654` | Strategy decisions, owner decision requests, Gameplay Evolution archive. |
| 6h development report | `discord:1497587260835758222:1497833662241181746` | Threaded development report target; preserve thread id. |

When using raw IDs and named channels together, this registry is the comparison source. Do not downgrade a thread target to a bare channel.

## Active cron jobs

| Job | ID | Schedule | Delivery | Purpose |
| --- | --- | --- | --- | --- |
| Screeps autonomous continuation worker | `f66ed36d7be0` | `8,28,48 * * * *` | `discord:#task-queue` | Dispatcher/reconciler for safe work lanes. |
| Screeps P0 agent operations monitor | `75cedbb77150` | `13,43 * * * *` | `discord:1497820688843800776` | P0 autonomous-system health monitor. |
| Screeps runtime room summary images | `befcbb7b2d60` | `23 * * * *` | `discord:1497588267057680385` | Runtime summary report/images for `E26S49`. |
| Screeps runtime room alert image check | `1c093252ab70` | `1,16,31,46 * * * *` | `discord:1497588512436785284` | Runtime alert/tactical response for `E26S49`. |
| Screeps dev-log fanout reporter | `d3bf35c278d5` | `25,55 * * * *` | `discord:#dev-log` | Dev log fanout from live repo/cron state. |
| Screeps research-notes fanout reporter | `3c0d20aa2e45` | `10,40 * * * *` | `discord:#research-notes` | Research/RL progress fanout. |
| Screeps roadmap fanout reporter | `92ca290f7996` | `34 * * * *` | `discord:#roadmap` | Roadmap/Pages image fanout. |
| Screeps 6h development report | `dfcaf65d7ea7` | `47 */6 * * *` | `discord:1497587260835758222:1497833662241181746` | 6h health/progress report. |
| Screeps Gameplay Evolution Review | `c7b3dda8f1ac` | `0 */8 * * *` | `discord:#task-queue` | 8h strategy review for current target `E26S49`. |
| Screeps Gameplay Evolution Review decisions archive | `dc1c46787f2e` | `15 */8 * * *` | `discord:1497586175580311654` | Archive accepted strategy decisions/current strategy. |
| Screeps RL flywheel steward | `aed8362e4501` | `17 */6 * * *` | `discord:#task-queue` | P1 RL flywheel progress lane. |

## Cron prompt drift rules

- Every cron prompt that reasons about room state must use `shardX/E26S49` as current target.
- Gameplay Evolution cadence is 8h, not 12h.
- The P0 monitor should audit this registry's expected jobs and should not treat intentional schedule/debug changes as abnormal unless the current registry says they are unhealthy.
- Reporter state files and old cron outputs are caches/history, not rules authority.
- When scanning cron output, ignore prompt/system/skill sections unless explicitly auditing historical prompt drift.
- Cron runs must not recursively schedule new cron jobs.
- Cron prompt updates require a pre-change snapshot and post-change `cronjob list` verification.
