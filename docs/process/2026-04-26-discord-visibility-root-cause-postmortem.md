# Discord Visibility Root Cause Postmortem

Last updated: 2026-04-26T04:46:00+08:00

## Incident

Several Screeps project Discord channels appeared stale even though autonomous work was still running. The user repeatedly observed that expected project-channel updates were missing.

## What was verified

- The continuation cron job `Screeps autonomous continuation worker` was enabled and running every 10 minutes.
- Recent continuation runs had `last_status=ok` and useful output existed under `~/.hermes/cron/output/f66ed36d7be0/`.
- The 4-hour checkpoint job was enabled.
- Named Discord project targets such as `discord:#task-queue`, `discord:#dev-log`, `discord:#research-notes`, and `discord:#roadmap` are resolvable.

## Root cause

This was not a single delivery typo. It was a routing-contract conflict across multiple state layers.

### 1. Cron workers can only reliably deliver one final response

Scheduled cron workers receive an instruction that their final response is auto-delivered and that they should not call `send_message` directly. Therefore one implementation worker does not naturally fan out to `#task-queue`, `#dev-log`, `#research-notes`, and `#roadmap`.

The intended workaround was to deliver the single cron final response to `#task-queue` and include labelled sections inside that message.

### 2. The project had two competing interpretations of “where updates should go”

There were two valid but different routing concepts:

- **Global/home notifications**: use home channel ID `1497537021378564200`; avoid old thread `1497579848594493560`.
- **Scheduled Screeps project progress/checkpoints**: use named project channel `discord:#task-queue` so the owner can see task progress where expected.

The mistake was treating these as the same thing. Later fixes for “global notifications should use home channel” overwrote the earlier `#task-queue` scheduled-worker delivery fix.

### 3. Durable docs and live cron config drifted and then corrected each other incorrectly

Evidence from prior sessions shows this sequence:

1. The continuation worker originally used local-only output, so reports were saved but not visible in Discord.
2. It was fixed to deliver to `#task-queue`.
3. A later global-notification-routing update changed scheduled jobs to numeric home channel `1497537021378564200`.
4. The user checked typed project channels and saw no updates.
5. The same superficial fix was applied again, but the stale `global-notification-routing` doc still described scheduled jobs as home-channel jobs, creating a path for future reversion.

### 4. Some manual/background outputs use separate routing paths

Manual main-agent messages can call `send_message` and fan out to multiple channels.

Hermes background process completion notifications are controlled by the process runtime, not by cron `deliver` or `send_message`, and may return to the invoking thread. This added noise but is not the main cause of stale project channels.

## Corrected contract

- Scheduled Screeps continuation/checkpoint jobs deliver to `discord:#task-queue`.
- Their single final response may contain labelled sections such as `#task-queue`, `#dev-log`, `#research-notes`, `#runtime-summary`, and `#roadmap`.
- Manual/interactive Hermes orchestration can still post separate messages to the typed channels.
- Global/home channel ID `1497537021378564200` is for broad notifications where the user explicitly wants home-channel delivery, not for routine scheduled Screeps project progress.
- Old thread `1497579848594493560` should not receive global status.

## Applied corrective action

- Updated both active cron jobs to `deliver=discord:#task-queue`.
- Rewrote the continuation-worker prompt to remove stale `sharedX` and stale home-channel delivery instructions.
- Rewrote the 4-hour checkpoint prompt to deliver to `discord:#task-queue`.
- This postmortem records the root cause so future agents do not simply toggle the same setting back and forth.

## Remaining limitation

If the owner expects actual separate scheduled posts in every project channel, a single continuation cron worker is the wrong mechanism. We should create separate narrow reporter jobs per channel, or an explicit fan-out reporter that is allowed to call `send_message`. Until then, `#task-queue` is the canonical scheduled-worker landing channel.
