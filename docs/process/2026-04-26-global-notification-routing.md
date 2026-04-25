# Global Notification Routing

Last updated: 2026-04-26T04:46:00+08:00

## User instruction

The user explicitly requested that broad/global notification/status reports use Discord home channel:

```text
1497537021378564200
```

They should not be sent to thread:

```text
1497579848594493560
```

## Clarification after visibility incident

Do not conflate broad/global notifications with routine scheduled Screeps project-progress reports.

The recurring visibility problem happened because a previous fix changed scheduled Screeps continuation/checkpoint jobs to `#task-queue`, but a later global-notification fix changed those same jobs back to numeric home-channel delivery. The user then looked in typed project channels and saw no updates even though cron runs were succeeding.

## Current routing semantics

- **Routine scheduled Screeps continuation/checkpoint reports**: deliver to named project channel `discord:#task-queue`.
- **Broad/global owner notifications**: may use home channel ID `1497537021378564200` when the notification is not a project task-progress report.
- **Interactive/manual main-agent fanout**: may post separate messages to typed project channels such as `#dev-log`, `#research-notes`, `#roadmap`, and `#runtime-summary`.
- **Original project thread `1497579848594493560`**: should not receive global notification/status messages.

## Current scheduled job values

- `Screeps autonomous continuation worker`
  - `deliver = discord:#task-queue`
- `Screeps 4h active-task progress summary`
  - `deliver = discord:#task-queue`

## Notes

Cron jobs typically deliver their final response to one configured target. Therefore scheduled Screeps workers should use `#task-queue` as the canonical landing channel and include structured sections such as `#task-queue`, `#dev-log`, `#research-notes`, or `#runtime-summary` inside the single delivered message when relevant.

If separate scheduled posts are required in multiple project channels, create separate narrow reporter jobs or a dedicated fan-out reporter with explicit permission to call `send_message`; do not keep toggling the implementation worker between home-channel and `#task-queue` delivery.
