# Toward Reinforcement-Learning-Assisted Self-Evolving Strategy for Hermes Screeps

Status: research paper task scaffold; full autoresearch tracked by GitHub issue #232.
Date: 2026-04-29

## Abstract

Hermes Screeps currently uses evidence-backed heuristic strategy reviews to pursue the ordered project vision: territory first, resources second, enemy kills third. The next strategic capability is not to replace that vision, but to make the strategy model itself evolvable. This paper will research how to move from hand-tuned scoring models toward reinforcement-learning-assisted strategy iteration using offline artifacts, private-server scenarios, and strict safety gates before any official MMO influence.

## Research questions

1. How should Screeps strategic state be represented under partial observability, limited CPU, persistent world memory, and non-stationary opponents?
2. Which decisions are appropriate for learned policies first: scoring weights, construction priorities, expansion target ranking, resource routing, defense posture, or full tick-level control?
3. What reward design best preserves the vision chain: survive reliably → expand territory → scale resources → defend/attack effectively → optimize kills?
4. What offline/private-server evaluation is sufficient before a learned or auto-tuned policy can affect official MMO code?
5. How should the 8-hour Evolution cron decide whether to tune parameters, revise a model, request more evidence, or open an RL research/implementation task?

## Initial method space to verify

- Heuristic scoring with versioned weights and evidence-backed changes.
- Contextual bandits for bounded strategy knobs such as construction weighting or expansion candidate ranking.
- Offline reinforcement learning from runtime summaries, event logs, Memory snapshots, and private-server traces.
- Imitation learning from known-good bot behavior or curated Hermes runs.
- Curriculum/self-play in private-server scenarios for expansion, economy, and defense tasks.
- Population-based training for strategy parameters after safe simulation harnesses exist.
- Hierarchical reinforcement learning where high-level strategy picks goals and existing deterministic bot code executes safe actions.

## Required related-work search

The full paper must verify and cite sources for at least these areas:

- RTS reinforcement learning and self-play, including StarCraft/AlphaStar-style lessons for long-horizon partial-observation games.
- MicroRTS or lightweight RTS benchmarks for reproducible strategy-learning experiments.
- Offline RL surveys and safety constraints for learning from historical traces.
- Population-based training and curriculum learning for strategy parameter evolution.
- Screeps community bot architecture patterns and operational constraints.

The first attempt to query public paper APIs from the controller hit transient arXiv timeout and Semantic Scholar rate limiting; the research worker should retry with bounded rate limits and record exact URLs/versions for all citations.

## Proposed safe landing architecture

1. **Strategy registry:** version expansion/construction/combat scoring models and record why each version changed.
2. **Shadow evaluator:** run candidate scoring models against saved observations without affecting the live bot.
3. **Private-server scenario suite:** evaluate candidate policies in repeatable room/economy/hostile scenarios.
4. **Bandit/weight tuning:** begin with bounded parameter recommendations, not direct tick-level learned control.
5. **Hierarchical RL:** only after evaluator maturity, let learned policy choose high-level goals while deterministic code handles safety-critical execution.
6. **Official MMO gate:** learned-policy influence requires paper acceptance, issue/PR/Project tracking, private validation, deployment evidence, and post-deploy observation.

## Reward contract

Reward functions must be subordinate to the durable project vision. A candidate reward may not optimize kills, CPU, or short-term energy if doing so damages earlier layers of the chain. Suggested reward components to research:

- survival/reliability floor: no loop exceptions, spawn recovery, controller downgrade avoidance;
- territory: owned/reserved room count, stable remote access, successful claim/reserve actions;
- resources: net harvested energy/minerals, storage growth, spawn utilization, RCL/GCL progress;
- defense/combat: hostile damage avoided, hostile creeps destroyed, own losses minimized;
- cost penalties: CPU, creep deaths, abandoned construction, unsafe expansion, failed deploy/rollback.

## Roadmap decomposition

- #232: complete this paper through autoresearch and accepted recommendations.
- Follow-up issue: implement strategy registry and shadow evaluator.
- Follow-up issue: add private-server scenario suite for expansion/construction strategy evaluation.
- Follow-up issue: test contextual-bandit or offline weight-tuning for construction/expansion scores.
- Follow-up issue: only after evidence, evaluate hierarchical RL for high-level strategic goal selection.

## Acceptance criteria for the completed paper

- Every related-work claim has a traceable citation.
- The paper names at least one near-term non-RL strategy-evolution slice and at least one long-term RL slice.
- The safety gate prohibits direct official MMO control by unvalidated learned policies.
- The implementation roadmap produces GitHub issues with verification and rollback criteria.
