# Cron Channel Delivery Semantics

Last updated: 2026-04-26T02:08:00+08:00

## Question

The user asked whether messages in channels such as `<#1497586175580311654>` and `<#1497586500647387266>` are produced normally, and whether they are worker output, main-agent output, or another source.

## Current behavior

There are two different output paths:

1. **Interactive/main-agent output**
   - The main Hermes agent can call `send_message` directly.
   - It can post separate messages to the appropriate Discord channels, such as `#research-notes`, `#task-queue`, and `#dev-log`.
   - Recent manual補发 messages came from this path.

2. **Scheduled cron worker output**
   - Cron job final responses are delivered by the scheduler to one configured `deliver` target.
   - In cron contexts, the injected delivery instruction may forbid direct `send_message` calls.
   - Therefore a single worker run cannot reliably fan out separate messages to multiple channels unless the scheduler provides a multi-delivery mechanism.
   - The continuation worker is currently configured to deliver to `#task-queue` and to include structured sections such as `#task-queue`, `#dev-log`, and `#research-notes` in that single delivered message.

## Important distinction

`#task-queue` is currently the canonical landing channel for scheduled worker reports. Other channels will receive normal messages when the interactive/main Hermes agent posts to them, but they should not be assumed to receive automatic scheduled-worker messages unless we create dedicated jobs for those channels or the scheduler supports multi-target delivery.

## Change applied

The 4-hour checkpoint job was also changed from local-only delivery to Discord `#task-queue`, so long-running checkpoint reports should be visible rather than silently saved to local files.

## Recommended operating rule

- Use `#task-queue` as the canonical scheduled-worker output stream.
- Use section headers inside worker reports to mirror channel categories.
- Use interactive/main-agent sends for true multi-channel fanout when immediate manual orchestration is active.
- If true per-channel scheduled output becomes necessary, create separate narrow reporter jobs for `#research-notes`, `#dev-log`, etc., instead of forcing one implementation worker to bypass cron delivery rules.
