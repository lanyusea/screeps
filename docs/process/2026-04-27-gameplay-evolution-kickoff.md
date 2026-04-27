# Gameplay Evolution专项 Kickoff

Date: 2026-04-27

## Trigger

The owner identified that current work was too infrastructure-heavy and lacked a durable loop from real game results to strategy/code-roadmap evolution.

## Research and audit completed

- Audited `/root/screeps` repo, active docs, runtime monitor, production telemetry, open issues, Project `screeps`, and cron metadata.
- Researched official Screeps metrics, official Expansion/Power rank signals, ScreepsPlus/Grafana practice, and mature bot statistics patterns from TooAngel and Overmind.
- Designed an agent model separating:
  - Gameplay Evolution Agent for 12-hour strategic reviews;
  - Tactical Emergency Response Agent for attacks/collapse;
  - Main Hermes Agent for authoritative decisions/GitHub/roadmap;
  - Codex for production code;
  - QA/Acceptance for independent delivery checks.

## Key conclusion

The next major project-management correction is not another generic infrastructure task. The project needs an evidence-backed gameplay evolution loop:

```text
runtime/game result evidence → KPI deltas → bottleneck diagnosis → accepted GitHub issue/task → Codex implementation → gated release → next 12h review
```

## Durable artifacts in this branch

- `docs/research/2026-04-27-gameplay-evaluation-framework.md`
- `docs/ops/gameplay-evolution-roadmap.md`
- `docs/process/2026-04-27-gameplay-evolution-kickoff.md`
- `docs/ops/roadmap.md` refreshed with a new Gameplay Evolution domain snapshot.

## Immediate follow-up

1. Created GitHub issue #59 as the umbrella专项 and issues #60–#63 for review cadence, task bridge, tactical response, and release gates.
2. Added all new issues to Project `screeps` with Status/Priority/Domain/Kind/Evidence/Next action/Next-point %.
3. Opened docs PR #64 for review.
4. Captured the owner priority correction as a hard contract: P0 automation blockers first; then game-goal delivery (`territory → resources → enemy kills`); then non-blocking foundation work; no unblocked roadmap line may lose worker coverage.
5. Configure a manual dry-run prompt for the 12-hour Gameplay Evolution Review; enable recurring cadence only after the first report is useful.
6. Dispatch Codex later for `prod/` KPI telemetry implementation, building on issue #29.
7. Keep parallel foundation/ops coverage active through #28 private-smoke release evidence, #62 tactical response wiring, #63 release/hotfix gate enforcement, and routine #27 P0 monitor watch.
