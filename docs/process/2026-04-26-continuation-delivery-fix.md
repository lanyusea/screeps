# Continuation Worker Delivery Fix

Last updated: 2026-04-26T02:04:20+08:00

## Issue

After manually triggering `Screeps autonomous continuation worker`, the worker did run and completed a useful slice, but no Discord channel message appeared.

Root cause:

- the continuation cron job was configured with `deliver=local`;
- cron runs inject a delivery instruction telling the worker not to call `send_message` directly and to place the report in the final response;
- because delivery was local, the report was saved under `~/.hermes/cron/output/` rather than sent to Discord.

Observed output file:

```text
~/.hermes/cron/output/f66ed36d7be0/2026-04-26_01-59-55.md
```

## What the worker actually completed

The run at `2026-04-26T01:59:55+08:00` completed `private-server-smoke-prep` documentation work:

- created `docs/ops/private-server-smoke-test.md`;
- created `docs/process/2026-04-26-private-server-smoke-prep.md`;
- updated `docs/process/active-work-state.md`;
- verified `prod` with typecheck, tests, and build;
- committed and pushed `5bf751b docs: prepare private server smoke runbook`;
- moved next active task to `deterministic-integration-hardening`.

## Fix applied

The continuation worker delivery target was changed from local output to Discord `#task-queue`:

```text
deliver = discord:1497587025140781206
```

The worker prompt was also updated so that cron-final responses are structured with sections labelled `#task-queue`, `#dev-log`, and `#research-notes` when relevant. This preserves visibility even though a single cron final response can only be delivered to one target.

## Follow-up note

Interactive/manual Hermes runs can still use `send_message` to post to multiple channels. Scheduled cron runs should rely on their configured final delivery target unless the cron system allows direct messaging in that run.
