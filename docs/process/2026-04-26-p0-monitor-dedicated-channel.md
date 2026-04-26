# P0 Monitor Dedicated Channel Routing

Date: 2026-04-26T12:55:00+08:00

## Trigger

The owner created a new Discord channel `<#1497820688843800776>` and requested that scheduled output from the `Screeps P0 agent operations monitor` be delivered there.

## Live change applied

Updated cron job:

- Job name: `Screeps P0 agent operations monitor`
- Job ID: `75cedbb77150`
- Previous delivery: general configured Discord home target (`discord`)
- New delivery: `discord:1497820688843800776`
- Schedule remains: every 15 minutes
- Workdir remains: `/root/screeps`

A one-time manual verification message was sent successfully to `discord:1497820688843800776`.

## Routing rationale

The home channel remains the owner command/proactive-report surface for main-agent interaction. P0 monitor output can be noisy or repetitive, so it now has a dedicated operations channel. The main agent should still escalate to home if a P0 anomaly requires urgent owner action.

## Durable docs updated

- `docs/ops/agent-operating-system.md`
- `docs/process/active-work-state.md`
- `docs/ops/roadmap.md`

## Anti-regression rule

Do not move `Screeps P0 agent operations monitor` back to generic `discord`/home delivery unless the owner explicitly requests it. Expected delivery target is now:

```text
discord:1497820688843800776
```
