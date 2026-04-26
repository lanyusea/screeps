# QA Acceptance Agent Contract

Date: 2026-04-26

## Context

The owner approved adding a dedicated QA / acceptance-check agent role because the main agent's checklist burden had grown across roadmap management, implementation coordination, PR/CI/merge verification, GitHub Issue/Project updates, durable docs, and Discord reporting.

A parallel task was already updating the GitHub-state-before-completion requirement in PR #40. To avoid conflict, this change deliberately avoids touching:

- `AGENTS.md`
- `docs/ops/github-issue-management.md`
- `docs/ops/github-roadmap-management.md`

This change is scoped to the agent operating-system and Discord coordination contracts.

## Decision

For meaningful deliverables, the main agent remains the project manager and final delivery owner, but must define explicit deliverables plus common and task-specific acceptance criteria for a QA / acceptance-check agent.

The QA agent independently verifies evidence and returns either:

- `PASS` — criteria are satisfied with cited evidence.
- `REQUEST_CHANGES` — one or more required criteria are missing, with concrete required fixes.

The QA agent does not own roadmap priority, final completion state, or cross-channel routing decisions.

## Implemented documentation changes

- `docs/ops/agent-operating-system.md`
  - Added the dedicated QA acceptance gate.
  - Added QA to the main-agent workflow.
  - Added QA acceptance output routing.
  - Added an anti-regression rule prohibiting completion without evidence-based QA for meaningful deliverables.
- `docs/ops/discord-project-spec.md`
  - Added QA acceptance-check responsibilities.
  - Added task-template QA gate field.
  - Added a QA acceptance-check message template.

## Verification plan

- `git diff --check`
- Confirm this branch does not modify the files owned by concurrent PR #40.
- Create a docs-only PR linked to issue #41.
- Use the new QA gate on this very change before final completion.
