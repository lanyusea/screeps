# Autonomous Progress Reporting Process Note

Date: 2026-04-25

## Context

During the Screeps project coordination setup, the project owner clarified an important distinction:

- Autonomous execution means the bot should not ask for intermediate permission to continue routine work.
- Autonomous execution does **not** mean process progress should disappear from Discord.

The Discord server is the operating surface for this project, so ongoing work must be visible in the appropriate channels even when no user decision is required.

## Rule

For all future Screeps work:

1. Research progress, sources, and interim findings go to `#research-notes`.
2. Task state, blockers, and queue updates go to `#task-queue`.
3. Implementation progress, file changes, verification commands, and Git state go to `#dev-log`.
4. Final direction-changing decisions go to `#decisions`.
5. If a task remains in progress for more than 4 hours without a final conclusion, publish a structured summary every 4 hours until conclusion.
6. Each 4-hour summary must also be recorded in `docs/process/` to preserve context across model context compaction and support future blog writing.

## 4-hour summary template

```text
[Long-running task summary]
[Task] ...
[Elapsed] ...
[Current objective] ...
[Completed since last summary] ...
[Evidence / sources / files] ...
[Current state] ...
[Open questions] ...
[Blockers] ...
[Next actions] ...
[Decision needed?] no / yes: ...
```

## Rationale

This rule addresses two risks:

1. **Project visibility risk** — autonomous work should remain observable in Discord without requiring manual prompting.
2. **Context degradation risk** — long-running tasks can exceed practical model context limits. Periodic summaries provide durable checkpoints that can be reloaded from docs instead of relying on transient conversation state.

## Implementation note

The project will use both:

- live Discord channel updates for operational visibility
- `docs/process/` notes for durable reasoning trails and blog-ready records

This process is now part of the canonical Discord workflow contract in `docs/ops/discord-project-spec.md`.
