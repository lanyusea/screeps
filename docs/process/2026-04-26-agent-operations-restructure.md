# Agent Operations Restructure

Last updated: 2026-04-26T04:56:00+08:00

## Trigger

The owner clarified that the repeated Discord visibility issue is not acceptable as a surface-level routing bug. The expected operating model is:

1. the home channel is where the owner talks to the main agent and receives proactive main-agent reports;
2. the main agent delegates minimal research/development tasks to subagents;
3. subagent conclusions return to the main agent;
4. the main agent routes summarized decisions, roadmap, task queue, research, dev, and runtime information to the corresponding Discord channels;
5. subagents stay narrow and do not own multi-channel synchronization;
6. monitoring agent communication and scheduled-worker health is the main agent's highest priority.

## Structural conclusion

The system needs an explicit agent operating-system layer, not just a Discord-channel spec.

The previous docs described channels well, but did not distinguish clearly enough between:

- owner-facing home channel;
- typed project channels;
- main-agent authoritative fanout;
- delegated subagent final results;
- spawned agent detail logs;
- cron final-response delivery;
- P0 operations monitoring.

## Changes made

- Added `docs/ops/agent-operating-system.md` as the canonical P0 operating-system contract.
- Updated the Discord project spec to reference the main-agent/subagent/P0 monitoring model.
- Updated active-work state so agent operating-system health has priority over normal development slices.
- Updated roadmap to add P0 operations health as the current top priority.
- Added a dedicated P0 health-monitor cron job design and live job.

## Operating change

From now on:

- P0 agent operating-system health overrides normal Screeps development.
- The main agent is accountable for reviewing subagent outputs and routing summaries.
- Continuation/checkpoint workers remain useful but do not replace main-agent fanout.
- A health monitor checks whether cron jobs, delivery targets, active-state readability, and repo state are sane.

## Follow-up needed

If the owner wants true real-time low-level progress from long-running spawned agents, the next structural increment should define per-agent log sinks and reporter jobs. For the current Hermes `delegate_task` pattern, the practical model is final result → main-agent review → channel fanout.
