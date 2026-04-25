# Typed Channel Fanout Reporters

Date: 2026-04-26T05:52:00+08:00

## Trigger

The owner reported again that several Discord channels appeared stale.

A P0 check showed that the core autonomous jobs were running:

- continuation worker was enabled and returning `ok`;
- P0 operations monitor was enabled and returning `ok`;
- runtime summary image job was enabled and had delivered a `#runtime-summary` image;
- runtime alert job was enabled and correctly returned `[SILENT]` when no alert existed.

However, typed channels such as `#dev-log`, `#roadmap`, and `#research-notes` could still appear stale because the continuation worker can only deliver one cron final response, normally to `#task-queue`.

## Root cause

The previous P0 operating-system restructure clarified that main-agent fanout is required, but the scheduled execution path still lacked a recurring bridge from continuation outputs to typed detail channels.

A single continuation worker should not independently post to every channel, but there still needs to be a scheduled visibility bridge for channels whose content is derived from continuation results.

## Structural adjustment

Added three narrow reporter jobs:

- `Screeps dev-log fanout reporter`
  - schedule: every 20m
  - deliver: `discord:#dev-log`
  - source: git log/status and latest continuation output
- `Screeps roadmap fanout reporter`
  - schedule: every 20m
  - deliver: `discord:#roadmap`
  - source: active-state, roadmap, latest continuation output
- `Screeps research-notes fanout reporter`
  - schedule: every 20m
  - deliver: `discord:#research-notes`
  - source: recent research/process docs and latest continuation output

Each reporter keeps local state under `/root/.hermes/screeps-reporters/` and returns exactly `[SILENT]` when there is nothing new.

## Important boundary

These reporter jobs are not new decision-makers and do not own project state. They are visibility bridges only.

The main agent remains responsible for:

- accepting owner tasks in home channel;
- delegating minimal work to subagents/Codex;
- reviewing returned conclusions;
- making/recording final decisions;
- routing authoritative summaries and blockers.

## Immediate manual correction

Before the reporters' first scheduled run, the main agent manually posted a P0 status correction to:

- home channel;
- `#task-queue`;
- `#dev-log`;
- `#roadmap`;
- `#research-notes`.

## Follow-up

The P0 operations monitor prompt was expanded so it also checks these reporter jobs. If any reporter becomes disabled, misrouted, failed, or stale after its first scheduled run, the monitor should report a P0 anomaly to the home channel.
