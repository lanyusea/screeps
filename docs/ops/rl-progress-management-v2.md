# RL Progress Management v2: No Umbrella Queues

Status: canonical operating contract for RL flywheel progress management after the #879 quarantine.

This document is a **contract**, not a queue. Do not append live status, per-run notes, or child-task lists here. Live state belongs only in GitHub Project `screeps` fields on atomic Issues/PRs and in linked artifacts/PR comments.

## Owner correction

A new broad issue must not replace the old broad issue. The failure mode was not the number `#879`; it was allowing any single issue to become a catch-all for unrelated RL progress, blockers, evidence, and Done claims.

Therefore:

- #879 is historical context only.
- #1589 is a short-lived migration ticket only. It is not an RL progress tracker, queue, parent epic, or completion proxy.
- No future issue may serve as "the RL flywheel issue" unless its body has one finite deliverable and can be closed by one PR/artifact/checkpoint.
- Reports must be generated from Project fields on atomic issues, not from membership in an umbrella issue.

## Source of truth

Use this query shape for active RL work:

```text
Project = screeps
Domain = RL flywheel
Status in {Ready, In progress, In review}
Issue/PR is open
Issue number != 879
```

Sort executable work by:

1. `Priority`: P0 before P1 before P2.
2. Unblocked before blocked.
3. Oldest stale `Next action` first among equally-ranked executable items.
4. If two items are equivalent, prefer the one whose evidence directly moves the first bounded official-MMO canary forward.

The query result is the queue. There is no manually maintained RL queue issue.

## Atomic issue requirements

An RL issue is valid only if all of these are true:

1. It names one deliverable, not a theme.
2. It has acceptance criteria that can be proven by a PR, artifact, command output, owner decision, or Project field update.
3. Its `Evidence` field names the latest proof or explicitly says no proof exists yet.
4. Its `Next action` is a single executable action another agent can perform without reading local chat history.
5. If blocked, it has `blocked` label plus `Blocked by` describing the exact blocker.
6. It can close independently without claiming that the whole RL flywheel is Done.

If an item fails these checks, repair it by narrowing the issue or creating smaller atomic issues, then move the broad item to historical/backlog. Do not create another broad item to summarize the smaller ones.

## Meta/governance issue limit

Meta issues are allowed only for bounded migrations of the management system itself. They must obey all of these limits:

- The title starts with the concrete migration, e.g. `Remove umbrella tracking from RL PM`.
- The body says explicitly: `This is not an RL progress tracker.`
- The checklist contains only migration edits, not RL implementation lanes.
- It has a closure trigger such as `contract PR merged + stale prompt audit complete`.
- It must not receive routine RL progress comments.
- It must not appear in steward dispatch candidates except as a governance bug to close.

#1589 fits only this migration category and should be closed once this contract, stale references, and steward prompts are updated. Any future RL work discovered during the migration must become its own atomic issue or update an existing atomic issue such as #1583, #1585, #1588, #1566, #1543, #1032/#1233, #1576, or #1555.

## Current lane identities

These are lane identities and ownership rules, not a queue table. Current status must be read from Project fields at runtime.

| Lane | Atomic owner | What can satisfy it | What cannot satisfy it |
| --- | --- | --- | --- |
| First bounded live canary | #1583 | canary plan, rollback dry-run, live health gate, post-rollout KPI evidence for a bounded high-level policy surface | a generic statement that RL progressed; role-policy work |
| Role-scoped policies | #1585 | separate worker/harvester/defender policy-family data, training, scorecards, and gates | top-level `construction-priority` canary or one generic candidate |
| Candidate differentiation | #1588 | fresh Loop A candidate-vs-baseline evidence showing non-identical policy behavior or a concrete blocker | reused stale Loop A evidence |
| Objective activation proof | #1566 | trusted multi-tier objective evidence before paid validation | smoke-scale metadata-only runs |
| Conclusion registry hygiene | #1543 | stale/open conclusions routed to atomic issues or closed with evidence | unresolved registry counts hidden behind an umbrella |
| Scale / compute cadence | #1032 / #1233 | validation-scale rows/ticks/utilization/cost/scale-down evidence and safe autonomous dispatch | paid compute launched before local gates pass |
| Observability | #1576 and Grafana/dashboard issues | owner-facing dashboard proof, freshness, and acceptance evidence | SQLite file existence alone |
| Reward decisions | #1555 or future decision issues | explicit decision record plus scorecard impact | editing reward behavior by prose or umbrella comment |

When a lane splits, create a new atomic owner issue for the split. Do not add a subsection to #879 or #1589.

## Reporting format

Every RL progress report must be generated from live issue/Project data and use this compact format:

```text
RL flywheel active lanes, generated from Project="screeps" Domain="RL flywheel":
| Issue | Lane | Priority | Status | Evidence | Next action | Blocker |
| #1583 | First bounded live canary | P0 | In progress/blocked | <latest Project Evidence> | <Project Next action> | <Blocked by or none> |
...
Excluded: #879 historical only; #1589 migration-only and omitted unless the report is specifically about PM-contract migration.
```

Forbidden report patterns:

- `#879 progressed`.
- `#1589 progressed` as a substitute for RL progress.
- `RL flywheel moved forward` without naming the exact atomic issue and evidence.
- Reporting a lane as Done from compile/Jest/build/CI/merge-only evidence when the lane requires functional/effect proof.

## Steward dispatch rule

The RL steward must select candidates from the live Project query above. It must exclude:

- #879;
- #1589 except when explicitly executing the PM-contract migration;
- closed/Done issues;
- items with `Blocked by` unless the selected action is to clear that exact blocker;
- historical docs or research papers that do not name one executable issue.

A steward run is successful only if it either:

1. advances one atomic issue with fresh evidence; or
2. records that all P0/P1 atomic issues are blocked, naming each blocker and the next unblock action.

## Done rules

An atomic RL issue can be marked Done only when its own acceptance criteria are met and Project fields are updated:

- `Status = Done`;
- `Evidence` includes PR/artifact/command/result/decision proof;
- `Next action` either names the next linked issue or says `Closed; no further action on this issue`;
- `Blocked by` is cleared;
- any recurring steward/report prompt no longer treats the closed issue as active.

A broad historical issue should not be reopened to capture repeated symptoms. Create a fresh atomic issue and link the older context.
