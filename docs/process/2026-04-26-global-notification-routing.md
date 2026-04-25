# Global Notification Routing

Last updated: 2026-04-26T03:35:00+08:00

## User instruction

Global notification/status messages should go to Discord home channel:

```text
1497537021378564200
```

They should not be sent to thread:

```text
1497579848594493560
```

## Applied changes

The scheduled global-reporting jobs were updated to deliver to the home channel:

- `Screeps autonomous continuation worker`
  - `deliver = discord:1497537021378564200`
- `Screeps 4h active-task progress summary`
  - `deliver = discord:1497537021378564200`

The worker prompts were also updated to explicitly avoid using the thread ID for global status/notification reports.

## Routing semantics

- **Global status / checkpoint / worker summaries**: home channel `1497537021378564200`.
- **Specific typed project channels**: still acceptable for interactive/manual main-agent fanout when the message is specifically research/dev/task/runtime oriented.
- **Original project thread `1497579848594493560`**: should no longer receive global notification/status messages.

## Notes

Cron jobs typically deliver their final response to one configured target. Therefore global scheduled reports should use the home channel and include structured sections such as `#task-queue`, `#dev-log`, `#research-notes`, or `#runtime-summary` inside the single delivered message when relevant.
