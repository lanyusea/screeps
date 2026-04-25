# Codex Coding Boundary

Last updated: 2026-04-26T01:35:45+08:00

## Trigger

The user clarified that coding work must be implemented by Codex, not directly by the main Hermes agent or generic subagents.

## Boundary

For Screeps production/test/build code changes under `prod/`:

- Implementation must be delegated to OpenAI Codex CLI.
- Hermes main agent acts as orchestrator: prepares Codex prompts, verifies results, updates docs, reports to Discord, and handles Git after verification.
- Generic subagents may be used for research, planning, or code review, but must not directly author production code.
- If Codex CLI is unavailable or blocked, the correct behavior is to report the blocker and preserve state, not to silently fall back to manual code editing.

## Applied configuration change

The existing cron job `Screeps autonomous continuation worker` was updated to enforce this boundary:

- attached skills: `codex`, `screeps-research-and-planning`
- implementation rule: code changes under `prod/` must run through Codex CLI
- direct Hermes file editing remains acceptable for documentation and state files
- verification remains the responsibility of the orchestrating Hermes agent

## Verification

Codex CLI availability was checked:

```text
/usr/local/bin/codex
codex-cli 0.125.0
```

The continuation worker remains scheduled and enabled after the update.

## Important nuance

The model/provider configuration `gpt-5.5` + `openai-codex` is not the same thing as invoking the Codex CLI coding agent. Going forward, implementation work must explicitly invoke `codex exec ...`; provider/model selection alone is not treated as sufficient delegation for coding.
