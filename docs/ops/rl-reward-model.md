# RL Reward Model Registry

Status: baseline registry slice for issue #907.

Metric taxonomy link: issue #906.

## Purpose

This document defines the reward-governance contract for RL Act decisions. Reward changes must be explicit GitHub-managed decision items with evidence, owner review, validation windows, and rollback criteria. They must not be hidden inside prompts, model intuition, ad hoc training runs, or untracked local artifacts.

The current production bot does not expose a deployed reward-weight registry. Any exact production reward weights, scalar coefficients, or decision-order values not already implemented in code are **baseline undefined until implemented**.

The existing offline training docs may describe specific helper behavior for prior slices. This registry is the durable change-control layer that decides when a reward definition is proposed, reviewed, trained, validated, accepted, rejected, or rolled back.

## Lexicographic Priority

Reward comparison must follow this order:

1. Reliability and safety floor.
2. Territory/control.
3. Resources/economy.
4. Enemy kills/combat value.
5. Efficiency and CPU constraints.

Reliability and safety are gates, not compensating reward. A candidate that violates safety, crashes the tick loop, loses required telemetry, or fails validation is rejected even if later gameplay metrics improve.

Territory dominates resources. Resources dominate kills. Efficiency and CPU are constraints and tie-breakers; they cannot justify territory loss, economy collapse, or safety regression.

## Reward Components

| Component | Conceptual formula | Direction | Current registry baseline |
| --- | --- | --- | --- |
| `reliability_safety_floor` | pass/fail from loop exceptions, malformed/missing telemetry, unsafe write flags, validation status, rollback gate status, and hard liveness floors | must pass | baseline undefined until implemented |
| `territory_control` | owned-room delta, survived expansion rooms, controller/RCL progress, reservation uptime, downgrade-risk reduction, room survival after claim | higher is better | baseline undefined until implemented |
| `resource_economy` | stored energy/resource delta, harvested and collected energy, useful transfer throughput, spawn/economy utilization, sustainable RCL/GCL conversion | higher is better | baseline undefined until implemented |
| `combat_value` | hostile creep/structure destruction, hostile objective denial, minus own creep/structure/room losses | higher is better | baseline undefined until implemented |
| `efficiency_cpu` | useful action per CPU, CPU bucket health, fewer wasted intents, fewer tiny-load or actionless ticks after preserving higher priorities | lower cost and higher useful work are better | baseline undefined until implemented |
| `construction_progress` | useful construction progress on priority sites when construction backlog exists, especially spawn, extension, tower, rampart, road, and container priorities | higher is better | baseline undefined until implemented |
| `worker_load_efficiency` | delivered energy per trip, carry utilization at delivery, avoid repeated return trips with negligible carried energy | higher useful delivery per trip is better | baseline undefined until implemented |
| `creep_action_liveness` | non-idle productive ticks, valid target/action success, no repeated stuck/actionless cycles | higher productive-action ratio is better | baseline undefined until implemented |
| `expansion_viability` | claimed/reserved expansion survival, spawn established after grace window, local worker/bootstrap continuity | higher viable expansion survival is better | baseline undefined until implemented |
| `defense_construction_readiness` | timely tower/rampart/road/repair construction or repair posture when hostile or downgrade risk evidence exists | higher timely defensive readiness is better | baseline undefined until implemented |

The component names above are governance names. A reward decision may map one governance component to one or more implementation metrics only after the linked decision is approved and implemented.

## Hard Gates

Every reward decision, training run, shadow evaluation, and policy candidate must preserve:

- `liveEffect:false`
- `officialMmoWrites:false`
- no official MMO writes, no Memory writes, no RawMemory writes, no spawn/creep/construction/market authority from learned output
- validation before training promotion
- validation before rollout promotion
- deterministic production validators remain the final gate before any later high-level live recommendation path

Default decision is reject. Missing evidence, missing metric definitions, unsafe flags, unknown state, or failed validation blocks advancement.

## Change-Control Rules

Reward changes advance through the decision registry in `docs/ops/rl-reward-decision-log.md`. A change may not enter training unless its proposal identifies:

- linked GitHub issue and metric evidence;
- current reward coverage;
- proposed change type, component, and direction;
- expected behavior change;
- risk and regression analysis;
- validation windows;
- acceptance criteria;
- rollback criteria;
- steward and owner decisions.

Accepted reward behavior must be traceable to a reviewed decision JSON, linked PRs, linked training runs, and linked policy evaluations.

## Rollback Conditions

Roll back a reward change, or reject the candidate before rollout, if any of these occur:

- reliability falls below the current rollout floor or loop exceptions increase;
- territory/control regresses outside the accepted window;
- a claimed room fails the expansion survival rule after the defined grace window;
- resources/economy regress beyond the accepted tolerance after higher-priority metrics tie;
- combat gains are purchased with own-room, own-spawn, or reliability loss;
- CPU bucket, tick latency, or useful-action-per-CPU degrades enough to threaten runtime stability;
- required metric evidence is missing, malformed, or contradicted by newer evidence;
- owner decision rejects or suspends the decision;
- validation or rollback helper output rejects the candidate.

Rollback restores the last accepted reward registry state and marks the decision `rolled_back` with the evidence window and linked rollback PR/run.

## Anti-Oscillation Rules

- Do not alternate reward direction for the same component without new metric evidence and owner review.
- Keep one active reward decision per component unless the linked decisions explicitly describe dependency ordering.
- Require at least one full validation window before reversing an accepted reward direction, except for safety rollback.
- Small bounded changes are preferred over broad reward rewrites.
- A failed candidate remains negative evidence; do not retry the same change under a new ID without explaining what evidence changed.
- Efficiency and CPU tuning must be treated as tie-breakers or floors unless the issue is a reliability blocker.

## Mapping Findings To Act Choices

| Behavior metric finding | Possible reward Act choice | Priority layer | Required evidence before approval |
| --- | --- | --- | --- |
| Missing or late defense construction | propose `defense_construction_readiness` component or hard gate for defense-critical construction backlog | reliability/safety, then territory | hostile/damage/downgrade context, construction backlog, build progress, tower/rampart/road/site state |
| Tiny-load returns such as 2/50 energy | propose `worker_load_efficiency` penalty or logistics throughput component | resources, then efficiency | carry load histograms, transfer target state, source/drop distance, delivered energy per trip |
| Stuck/actionless creeps | propose `creep_action_liveness` penalty or reliability gate when repeated | reliability/safety, then resources | idle/actionless tick ratio, stuck position evidence, action result codes, task assignment state |
| `build=0` with construction backlog | propose `construction_progress` reward or construction backlog gate | territory/resources | construction site count, priority site types, worker availability, energy availability, build work ticks |
| Claim/expansion room with 0 spawns after grace window | propose `expansion_viability` survival rule or territory component adjustment | territory | claim timestamp, grace window, spawn/site state, local worker/bootstrap continuity |
| CPU, reliability, or missing metrics | hard gate: block training, candidate promotion, or rollout until metrics are available and stable | reliability/safety | runtime summary integrity, CPU bucket/window data, validator output, telemetry freshness |

These mappings are proposal starting points, not accepted reward changes. Each Act choice must be recorded in the decision log and validated through the template before it can affect training or rollout.
