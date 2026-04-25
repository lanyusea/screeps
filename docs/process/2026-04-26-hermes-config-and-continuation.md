# Hermes Config Reload and Autonomous Continuation Note

Date: 2026-04-26

## Context

The project owner modified the Hermes config and asked whether the main flow can continue automatically after hitting the tool-calling / turn limit, instead of requiring manual re-triggering.

## Config state observed

Relevant Hermes config after reload/inspection:

- Main model: `gpt-5.5`
- Main provider: `openai-codex`
- Base URL: `https://chatgpt.com/backend-api/codex`
- Agent max turns: `150`
- Delegation model: `gpt-5.5`
- Delegation provider: `openai-codex`
- Delegation max iterations: `50`
- Delegation child timeout: `600s`
- Compression enabled: yes, threshold `80%`, target ratio `20%`
- Discord configured

`hermes doctor --fix` reported OpenAI Codex auth as logged in and config version current. Warnings remain for optional systems such as Docker, web-search API keys, and some optional auth providers.

## Answer: automatic continuation after hard tool-call limit

There is no direct in-turn hook exposed to the agent that fires exactly when the current main response reaches the platform's maximum tool-calling iteration limit. When that hard limit is hit, the current turn is forced to stop.

However, the project can approximate the desired behavior with a watchdog/continuation worker:

1. Keep active task state in `docs/process/active-work-state.md`.
2. Run a scheduled continuation worker on a short interval.
3. Each worker run inspects active state and git status.
4. If there is pending/in-progress work, it executes one bounded continuation slice.
5. It reports progress to Discord channels.
6. It updates process docs.
7. It commits/pushes only when there is meaningful verified progress.

## Implemented mitigation

Created cron job:

- Name: `Screeps autonomous continuation worker`
- Schedule: every 30 minutes
- Model: `gpt-5.5`
- Provider: `openai-codex`
- Workdir: `/root/screeps`
- Purpose: resume/continue active Screeps work after the main flow stops, including after tool-call/turn limits.

This does not literally continue the same model turn, but it continues the project from durable state and docs without requiring the user to manually re-trigger the next step.

## Interaction with existing 4-hour checkpoint

Existing job remains:

- `Screeps 4h active-task progress summary`

Roles:

- 30-minute continuation worker: does bounded autonomous work. It was later tightened to a 10-minute interval because 30 minutes is too slow for active development recovery after gateway restarts or context interruptions.
- 4-hour checkpoint worker: summarizes long-running tasks and preserves context.

## Caveats

- The continuation worker may run while a human-triggered main turn is also active. Its prompt instructs it to inspect git status and stop if uncommitted external changes are unsafe to modify.
- It should not recursively create cron jobs.
- It should not commit routine checkpoint noise.
- True exact continuation at the moment of a hard tool-call limit would require a Hermes/platform-level hook, not just prompt/config changes.
