# Background Process Notification Routing

Last updated: 2026-04-26T03:50:44+08:00

## Incident

A Hermes background process completion notification for `proc_6245feed3039` appeared in thread `1497579848594493560` even though global/public project notifications should go to home channel `1497537021378564200`.

The notification text started with:

```text
[Background process proc_6245feed3039 finished with exit code 0]
```

and included Docker Compose output for the Screeps private-server smoke environment.

## Source

This was not a normal `send_message` call and not a cron final-response delivery. It was an automatic Hermes background-process completion notification emitted by the terminal/process runtime for a background command started with completion notification behavior.

The process log shows the command completed successfully after Docker pulled/created/started the private-server smoke containers:

```text
Container screeps-private-smoke-screeps-1 Started
```

## Routing implication

Cron `deliver` targets and `send_message` channel routing do not control these low-level background-process completion notifications. They can be routed back to the invoking conversation/thread.

## Applied mitigation

> Superseded for scheduled Screeps project progress: a later routing postmortem corrected the continuation and 4-hour checkpoint workers back to the named project channel `discord:#task-queue`. Keep this note only for its still-valid warning that terminal background-process completion notifications bypass normal cron `deliver` and `send_message` routing.

Prompts should explicitly instruct future runs to avoid `notify_on_complete=true` background terminal processes for public/global updates. Long shell tasks should instead use one of these patterns:

1. Foreground command with sufficient timeout when bounded.
2. Background command without `notify_on_complete`, followed by explicit `process.poll` / `process.wait` and a final report delivered through the intended cron final-response target.
3. Cron final-response delivery to the configured scheduled-job target; for Screeps continuation/checkpoint progress, the canonical target is `discord:#task-queue`.

## Policy

Global/home status notifications may use:

```text
1497537021378564200
```

Scheduled Screeps project progress/checkpoints should use the named project channel:

```text
discord:#task-queue
```

They should not be sent to thread:

```text
1497579848594493560
```
