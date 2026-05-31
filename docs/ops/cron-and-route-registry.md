# Screeps Cron and Route Registry

Last updated: 2026-05-23
Tracking issues: https://github.com/lanyusea/screeps/issues/620, https://github.com/lanyusea/screeps/issues/1122, https://github.com/lanyusea/screeps/issues/1170, https://github.com/lanyusea/screeps/issues/1178

This registry is the expected-state contract for Screeps/Hermes cron jobs and Discord delivery routes. It is not passive documentation: P0 monitor, scheduler, and acceptance checks must compare live cron metadata against this file with `scripts/check_cron_registry.py`.

## Registry enforcement policy

- The registry uses **方案 1** from the 2026-05-16 owner decision: keep the registry and make it machine/audit enforced.
- Live cron metadata (`cronjob list` / `~/.hermes/cron/jobs.json`) says what currently exists; this registry says what should exist.
- A job missing from live metadata, an unexpected recurring live job, wrong cadence, wrong delivery target, wrong provider/model, wrong repeat policy, wrong workdir, or paused expected job is Agent OS drift.
- Drift is P0 when it affects scheduler, P0 monitor, runtime alerting, owner-decision routing, deploy/runtime safety, or GitHub/Project reconciliation.
- Old cron outputs and reporter state files are caches/history, not authority.
- Before changing any live cron definition, create a rollback snapshot of `~/.hermes/cron/jobs.json` and relevant docs; after changing, run `cronjob list` and `python3 scripts/check_cron_registry.py --strict`. Expected recurring jobs are healthy when `enabled=true` and state is either `scheduled` or transiently `running`; paused/disabled/error states are drift unless explicitly documented as an active maintenance window.

Verification command:

```bash
python3 scripts/check_cron_registry.py --strict
```

## Current target

- Official bot deployment and gameplay target: `main / shardX / E29N55`; `Spawn1` at `(17,24)`.
- Runtime monitoring and alerting jobs (`befcbb7b2d60`, `1df5ef0c3835`) auto-discover all owned rooms via `/api/user/overview` and are not constrained to the single-room target.
- Old room references (`W3N9`, `E24S49`, `E19S55`, `E22S49`, `E48S28`, `E48S29`, `E26S49`, `E17S59`, `E19S57`) are historical incident/fallback or superseded rooms unless explicitly retargeted by the owner.

## Seasonal smoke note

No Seasonal World cron job is active yet. Future Seasonal jobs must use separate names, env selectors, state files, cache directories, and artifact roots, including `SCREEPS_API_URL=https://screeps.com/season`, `SCREEPS_SHARD=shardSeason`, `runtime-artifacts/seasonal/...`, and `/root/.hermes/screeps-seasonal-runtime-monitor/...`. They must preserve the existing persistent MMO jobs and must not reuse persistent monitor state or cache paths.

Seasonal World reporting is also separate from the persistent/general Discord routes. Pin-message confirmations in the Seasonal channels are historical setup chatter; this registry is the durable route source of truth.

## Discord routes

| Purpose | Target | Notes |
| --- | --- | --- |
| Owner command / main thread | current Discord thread/home | Main-agent command and owner-facing summary surface. |
| Rules archive | `discord:1499621566164504766` | Final rules standards are archived here. |
| Task queue | `discord:#task-queue` | Continuation/RL scheduling and active task state. |
| Research notes | `discord:#research-notes` | Factual findings and RL/research progress. |
| Dev log | `discord:#dev-log` | Implementation, verification, commits, files changed. |
| Runtime summary | `discord:1497588267057680385` | Routine room summary images/reports. |
| Runtime alerts | `discord:1497588512436785284` | P0 runtime alert/tactical response. |
| P0 operations | `discord:1497820688843800776` | Owner-action and autonomous-system health blockers. |
| Gameplay decisions/archive | `discord:1497586175580311654` | Strategy decisions, owner decision requests, Gameplay Evolution archive. |
| 6h development report | `discord:1497587260835758222:1497833662241181746` | Threaded development report target; preserve thread id. |
| Seasonal roadmap | `discord:1504888618651488407` | Seasonal World phases, milestones, readiness gates, evidence, next action, and owner decisions only. |
| Seasonal task queue | `discord:1504888933832589362` | Seasonal GitHub Issue/Project task state and blockers. Done requires QA-agent acceptance. |
| Seasonal dev log | `discord:1504889127227621507` | Seasonal Codex/dev/test/PR/merge-gate and QA-agent evidence. Persistent MMO may appear only as no-impact proof. |
| Seasonal runtime summary | `discord:1504889233670930442` | Periodic Seasonal runtime snapshots only: profile/API/shard/rooms/branch/state/KPI/artifact/no-impact note. |
| Seasonal runtime alerts | `discord:1504889421655314512` | Urgent Seasonal runtime alerts only, using severity/evidence/impact/action/owner-need/next-check fields. |

When using raw IDs and named channels together, this registry is the comparison source. Do not downgrade a thread target to a bare channel. Do not route Seasonal World routine/status/alert traffic into persistent MMO routes unless the message is an explicit cross-link to the Seasonal channel.

Roadmap reporting is not a Discord route. The canonical owner-facing roadmap surface is GitHub Pages: https://lanyusea.github.io/screeps/. Refresh `docs/index.html` and `docs/roadmap-data.json` with `scripts/generate-roadmap-page.py` and commit those artifacts when roadmap data changes.

## Expected recurring cron jobs

The table below is machine-read by `scripts/check_cron_registry.py`. Keep one job per row and preserve the column names.

Repeat policy values:

- `forever` — live repeat should be `forever`.
- `high-horizon` — live repeat may show consumed/limit such as `1276/999999`; the limit must remain high enough for effectively always-on infrastructure.
- `once` — one-shot jobs only; do not use in this recurring table.

`Workdir` uses `-` to mean an explicit expectation that the job has no durable cron workdir. This is different from "unknown": the verifier should flag a live workdir on a `-` row because shared workdirs can serialize otherwise independent jobs behind repo-bound workers.

| Job | ID | Schedule | Delivery | Provider | Model | Workdir | Repeat | Criticality | Purpose |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Screeps autonomous continuation worker | `f66ed36d7be0` | `8,28,48 * * * *` | `discord:#task-queue` | `openai-codex` | `gpt-5.5` | `/root/screeps` | `high-horizon` | P0 | Dispatcher/reconciler for safe work lanes. |
| Screeps P0 agent operations monitor | `75cedbb77150` | `7,37 * * * *` | `discord:1497820688843800776` | `deepseek` | `deepseek-v4-flash` | `-` | `forever` | P0 | Autonomous-system health monitor, registry-drift detector, and consolidated Tencent Cloud cost guard. |
| Screeps runtime room alert text check | `1df5ef0c3835` | `1,16,31,46 * * * *` | `discord:1497588512436785284` | `openai-codex` | `gpt-5.5` | `-` | `forever` | P0 | Runtime alert/tactical response for all owned rooms; no-alert runs return exactly `[SILENT]`. |
| Screeps owner-decision escalation fanout | `bbc7f783075e` | `3,13,23,33,43,53 * * * *` | `discord:1497586175580311654` | `deepseek` | `deepseek-v4-flash` | `-` | `high-horizon` | P0 | Mirrors fresh unresolved owner-action decisions to the canonical decisions route. |
| Screeps runtime room summary images | `befcbb7b2d60` | `58 * * * *` | `discord:1497588267057680385` | `deepseek` | `deepseek-v4-flash` | `-` | `high-horizon` | P1 | Runtime summary report/images for all owned rooms. |
| Screeps console capture (live energy telemetry) | `7ee147327ba6` | `*/30 * * * *` | `local` | `deepseek` | `deepseek-v4-flash` | `-` | `forever` | P1 | Local bounded console/energy telemetry collector. |
| Screeps dev-log fanout reporter | `d3bf35c278d5` | `25,55 * * * *` | `discord:#dev-log` | `deepseek` | `deepseek-v4-flash` | `-` | `forever` | P1 | Dev log fanout from live repo/cron state. |
| Screeps research-notes fanout reporter | `3c0d20aa2e45` | `10,40 * * * *` | `discord:#research-notes` | `deepseek` | `deepseek-v4-flash` | `-` | `forever` | P1 | Research/RL progress fanout. |
| Screeps 6h development report | `dfcaf65d7ea7` | `47 */6 * * *` | `discord:1497587260835758222:1497833662241181746` | `deepseek` | `deepseek-v4-flash` | `-` | `high-horizon` | P1 | Threaded 6h health/progress report. |
| Screeps Gameplay Evolution Review | `c7b3dda8f1ac` | `0 */8 * * *` | `discord:#task-queue` | `deepseek` | `deepseek-v4-flash` | `-` | `high-horizon` | P1 | 8h strategy review for current target `E29N55`. |
| Screeps Gameplay Evolution Review decisions archive | `dc1c46787f2e` | `15 */8 * * *` | `discord:1497586175580311654` | `deepseek` | `deepseek-v4-flash` | `-` | `high-horizon` | P1 | Archive accepted strategy decisions/current strategy. |
| Screeps RL flywheel steward | `aed8362e4501` | `17 * * * *` | `discord:#task-queue` | `openai-codex` | `gpt-5.5` | `/root/screeps` | `high-horizon` | P1 | RL flywheel stewardship and issue/Project reconciliation. |
| Screeps RL shadow-eval bounded gate | `d6cff532edd4` | `5 * * * *` | `discord:#task-queue` | `deepseek` | `deepseek-v4-flash` | `-` | `high-horizon` | P1 | Shadow-eval ledger producer for RL candidate/baseline evidence. |
| Screeps RL training execution ledger | `5c869e7d8a1d` | `14,44 * * * *` | `discord:#task-queue` | `deepseek` | `deepseek-v4-flash` | `-` | `high-horizon` | P1 | Training execution ledger for offline/private RL campaigns; owns Tencent RL utilization control through its preflight instead of a standalone cron. |
| Screeps RL policy online advantage ledger | `01609968392a` | `27,57 * * * *` | `discord:#task-queue` | `deepseek` | `deepseek-v4-flash` | `/root/screeps` | `high-horizon` | P1 | Online advantage ledger comparing candidate policy signals against baseline. |
| Hermes state daily backup | `bf68a3951853` | `0 4 * * *` | `local` | `deepseek` | `deepseek-v4-flash` | `-` | `forever` | Support | Daily private Hermes-state backup. |

## Transient and retired cron jobs

Transient one-shot jobs must have an expiry condition and tracking issue. They should be removed after execution or after the condition is superseded. The strict recurring-job verifier ignores live jobs whose repeat policy is one-shot so an unrelated scheduled migration does not fail recurring drift checks, but active one-shots still need explicit owner/controller tracking outside this recurring table.

| Job | ID | Status | Action |
| --- | --- | --- | --- |
| E29N55 postdeploy 15m observation | `6b006603d7fa` | Retired/stale one-shot from E29N55 recovery | Remove after backup; rely on recurring runtime summary/alert and explicit postdeploy artifacts instead. |
| Screeps Tencent Cloud $50 billing guard | `d3513ab57840` | Retired standalone recurring job after 2026-05-18 owner correction | Cost monitoring is now reused inside P0 agent operations monitor `75cedbb77150`; do not recreate this standalone local cron. |
| Screeps Tencent RL utilization controller | `dc78f1939bce` | Retired standalone recurring job after 2026-05-18 owner correction | Tencent utilization control is now reused inside RL training execution ledger `5c869e7d8a1d`; do not recreate a separate task-queue-delivering utilization cron. |

## Cron prompt drift rules

- Every cron prompt that reasons about room state for gameplay/bot-deployment purposes must use `shardX/E29N55` as current target. Runtime monitoring/alerting jobs that auto-discover rooms via API are exempt from single-room targeting.
- P0 monitor and continuation/scheduler jobs must consult the registry diff before reporting cron health as OK or dispatching unrelated non-urgent work.
- Tencent Cloud cost monitoring is owned by P0 agent operations monitor `75cedbb77150`; standalone billing-guard cron jobs are retired and must not be recreated.
- Tencent RL batch utilization is owned by RL training execution ledger `5c869e7d8a1d`; standalone utilization-controller cron jobs are retired and must not deliver directly to Discord.
- Incident/postdeploy/Project-field follow-ups should reuse runtime alert/summary, continuation worker, P0 monitor, or RL ledger mechanisms instead of creating ad-hoc temporary crons unless the owner explicitly approves a non-spamming new surface.
- Roadmap Pages are the canonical roadmap surface at https://lanyusea.github.io/screeps/. Do not create or restore scheduled Discord delivery for roadmap/page reporting; refresh the committed Pages artifacts instead.
- Gameplay Evolution cadence is 8h, not 12h.
- Reporter state files and old cron outputs are caches/history, not rules authority.
- When scanning cron output, ignore prompt/system/skill sections unless explicitly auditing historical prompt drift.
- Cron runs must not recursively schedule new cron jobs.
- PR-draining/continuation cron prompts must include the CodeRabbit assertive-mode triage rule: use Codex to classify each automated review finding before choosing a patch or thread/comment resolution, and never merge with pending/untriaged CodeRabbit/Gemini feedback.
- Cron prompt updates require a pre-change snapshot and post-change `cronjob list` verification.
- Long-lived recurring Screeps jobs should be configured as `forever` or with a very high repeat horizon. A finite `999` cap on critical recurring jobs is abnormal because it can silently stop automation after enough successful runs.
- Repo/worktree-manipulating cron jobs must keep a stable current directory. Use `/root/screeps` as the default controller cwd, prefer `git -C <path>` or subshells over persistent `cd`, and return to `/root/screeps` before deleting any linked worktree.
- Metrics/ledger jobs that can use absolute repo paths and a preflight script should not hold a durable cron `workdir` if doing so prevents natural scheduler sessions. The Loop A training execution ledger `5c869e7d8a1d` intentionally has `Workdir=-` after #1178; do not restore `/root/screeps` unless a verified run proves it no longer starves behind the repo workdir lane.
