# Owner decision: unreliable automated review can be bypassed

Date: 2026-06-12
Discord decision message: `1514861910908993646`
Tracking issue: https://github.com/lanyusea/screeps/issues/1817

## Decision

When CodeRabbit or Gemini review is considered unreliable, the controller may skip that reviewer instead of treating the missing/non-substantive review as an indefinite merge blocker.

## Reliability-bypass conditions

A bypass may be recorded when the reviewer is unreliable, unavailable, rate-limited, skipped, stale, stuck pending without substantive output, on an older head, or otherwise non-substantive for the exact PR head.

## Required evidence

The PR or Project evidence must record:

- reviewer being bypassed;
- exact PR head SHA;
- why the review signal is unreliable;
- required-check status;
- GraphQL review-thread state;
- QA/controller judgment that the project critical-only review threshold remains satisfied.

## Non-waived gates

The bypass does not waive:

- green required checks;
- resolved/outdated/non-blocking review threads;
- current issue/PR Project fields;
- QA/acceptance checks;
- the elapsed review window.

Credible active automated findings still require normal triage or resolution before merge.
