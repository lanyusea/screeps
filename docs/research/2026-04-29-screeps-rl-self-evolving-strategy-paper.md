<!-- markdownlint-disable MD013 MD034 -->

# Toward RL-Assisted Self-Evolving Strategy for Hermes Screeps

Status: full autoresearch paper for GitHub issue #262; corrects the #232 completion scope, where PR #234 delivered the strategy-evolution vision and this paper's scaffold but not the completed autoresearch.
Date: 2026-04-29

## Abstract

Screeps: World is a persistent, partially observable MMO real-time strategy environment where the player ships code rather than issuing manual commands. That makes Hermes strategy improvement both unusually attractive for learning systems and unusually risky: a bad controller can waste CPU, corrupt persistent `Memory`, lose rooms while the world keeps running, or optimize a proxy metric that conflicts with the project vision. This paper recommends a staged self-evolving strategy program that preserves the ordered reward contract **territory > resources > enemy kills**. Near-term work should not train an end-to-end online policy. It should create a versioned strategy registry, offline/shadow evaluator, and private-server scenario suite, then use bounded heuristic evolution and contextual-bandit tuning for strategy knobs. Offline RL, imitation learning, hierarchical RL, self-play, population-based training, curriculum learning, and model-based planning are valuable later, but only after safe artifacts, deterministic reducers, and rollback gates exist.

## 1. Problem definition: Screeps as a persistent RTS learning problem

### 1.1 Environment

Screeps: World exposes a long-lived MMO world controlled by JavaScript/TypeScript code. Official documentation describes a tick-based game loop where exported `loop` code runs each tick, game-state changes take effect on subsequent ticks, global variables are not durable across ticks, and persistent state is stored through `Memory`/`RawMemory`/segments/inter-shard mechanisms. The public server also imposes CPU limits and bucket behavior, making compute cost part of gameplay rather than an implementation detail. Sources: official game loop, CPU limit, Memory, RawMemory, and API docs [S1]-[S5].

For Hermes, the strategic target is the official MMO on `main`, shard `shardX`, room `E48S28`. The durable project vision orders outcomes as:

1. enough large territory: claim, hold, defend, and operate rooms;
2. enough resources: convert territory into energy, minerals, infrastructure, logistics, and throughput;
3. enough enemy kills: remove threats and win fights after expansion/economy foundations exist.

Strategy self-evolution is a capability layer underneath that ordered vision, not a fourth reward that can override it.

### 1.2 State

A Screeps strategy learner cannot assume a fully observed Markov state. Useful observations include:

- **Owned-room state:** controllers, RCL/GCL progress, downgrade timers, structures, construction sites, storage/terminal contents, towers, spawn availability, creep bodies and TTLs.
- **Remote/territory state:** scout observations, room ownership/reservation, sources/minerals, exits, hostile structures/creeps, path cost, reservation and claim viability.
- **Economy state:** harvest/haul/upgrade/build/repair rates, spawn queue pressure, source utilization, dropped resources, terminal/market opportunities, CPU per outcome.
- **Combat state:** event-log attacks and object destruction, hostile body composition, rampart/tower readiness, safe-mode availability, own losses.
- **Runtime state:** CPU used/bucket, exceptions, global resets, telemetry silence, Memory schema version, strategy version, experiment assignment.
- **Historical artifacts:** runtime summaries, room snapshots, event logs, private-server traces, KPI reductions, PR/deploy metadata.

Screeps observations are partial and stale: rooms outside vision are unknown, opponents can change code asynchronously, and a strategy action such as expansion can take thousands of ticks to reveal its outcome.

### 1.3 Actions

Learning should begin at high-level strategy seams, not tick-level creep commands. Candidate action spaces by safety level:

1. **Offline recommendations only:** rank candidate changes, emit explanations, but do not affect the live bot.
2. **Bounded strategy knobs:** adjust weights in construction priority, expansion scoring, spawn mix targets, repair/rampart thresholds, remote-mining enablement, or defense posture within owner-approved min/max ranges.
3. **Versioned policy selection:** choose among hand-reviewed strategy model versions using context and shadow evidence.
4. **Hierarchical goals:** select goals such as "reserve remote X", "raise rampart floor", or "bootstrap room Y" while deterministic code handles safety-critical execution.
5. **Direct tick-level control:** choose creep actions or raw intents. This is explicitly out of scope until the bot has mature simulation, private-server validation, and rollback infrastructure.

### 1.4 Reward and credit assignment

The reward contract must be lexicographic, not a single undisciplined scalar. A scalar score may be used inside an evaluator only if it is derived from the ordered chain and cannot let later objectives compensate for failures in earlier ones.

Recommended lexicographic gates:

1. **Reliability floor:** no loop crashes, no Memory corruption, spawn recovery works, controller downgrade risk stays bounded, CPU bucket remains safe.
2. **Territory:** owned rooms, reserved/remote uptime, successful claim/reserve actions, controller progress that supports expansion, room-loss avoidance.
3. **Resources:** net harvested/stored useful resources, RCL/GCL progress, spawn/logistics throughput, sustainable remote income.
4. **Combat/kills:** hostile creeps/structures destroyed, hostile damage avoided, objective success, own losses minimized.
5. **Cost penalties:** CPU, excess deaths, abandoned sites, unsafe expansion attempts, deployment/rollback failures.

Long-horizon delayed effects are central: a construction-priority change may affect RCL days later; a remote-mining choice may look profitable until a hostile arrives; a combat posture may reduce short-term energy but protect territory. That favors offline counterfactual evaluation and private scenarios before any online optimization.

### 1.5 Non-stationarity and constraints

Screeps is non-stationary because other players deploy new code, rooms change ownership, seasonal/private environments differ from the official MMO, and the bot's own code evolves. CPU, memory size, module format, `RawMemory` segment limits, shard isolation, tick resolution, and official/private server API differences constrain any learning loop [S1]-[S7]. These constraints make large online RL loops unsafe on the official server and push the architecture toward offline datasets, scenario replication, and bounded knobs.

## 2. Related work and what it implies for Screeps

### 2.1 RTS and imperfect-information game learning

DeepMind's AlphaStar showed that StarCraft II agents can achieve grandmaster-level performance using large-scale supervised learning from human data, multi-agent reinforcement learning, league/self-play, and carefully engineered interfaces for a long-horizon, partially observed RTS [R1]. The lesson for Hermes is not "train AlphaStar for Screeps"; it is that high-performing RTS learning used extensive infrastructure, demonstrations, opponent diversity, and evaluation gates before deployment.

OpenAI Five in Dota 2 showed another large-scale self-play path for long-horizon multi-agent game control, but it required enormous compute, a constrained hero/item pool during development, and an environment with resettable matches [R2]. Screeps official MMO does not reset on demand, so self-play belongs on private scenarios, not live rooms.

MicroRTS is a lightweight RTS benchmark used in research because it enables reproducible experiments with small maps, scripted opponents, and fast simulation [R3]. It supports the idea that Hermes should build small private-server scenario slices before treating the MMO as an evaluator.

General RTS research surveys emphasize real-time constraints, partial observability, spatial/temporal abstraction, adversarial planning, and long-term resource allocation [R4]. Those map directly to Screeps expansion, logistics, defense, and CPU budgeting.

### 2.2 Screeps official and community systems

Official Screeps docs establish the persistent tick loop, CPU/bucket model, Memory/RawMemory persistence, room/controller progression, and private server support [S1]-[S7]. Community systems show practical bot patterns: Overmind uses layered colonies/directives/overlords/tasks, phase-separated tick processing, caching, and CPU-aware architecture; its blog explicitly discusses evolution and architecture changes [C1]-[C6]. TooAngel and Overmind dashboards/stat modules, plus the ScreepsPlus ecosystem, show that serious Screeps bots rely on telemetry, Grafana/stat streams, and outcome tracking [C7]-[C10].

Implication: self-evolution should first integrate with strategy registries, telemetry, and task/intent seams rather than bypassing the bot's deterministic architecture.

### 2.3 Offline RL and batch-constrained learning

Offline RL surveys describe the core problem of learning from fixed datasets without online interaction and warn about distribution shift and overestimation for actions not covered by the data [R5]. Algorithms such as Conservative Q-Learning penalize out-of-distribution value estimates to reduce unsafe extrapolation [R6], while Decision Transformer frames return-conditioned behavior sequence modeling from logged trajectories [R7]. These are relevant for Hermes traces, but only after logs include enough state/action/reward context and after private validation checks whether learned recommendations transfer.

For Screeps, offline RL should start as **policy evaluation and recommendation generation**, not authority over live decisions. Historical data will be biased by the current bot's limited behavior, sparse exploration, and changing code versions.

### 2.4 Imitation learning and behavior cloning

Behavior cloning is supervised learning from demonstrations; it is simple but suffers from compounding errors when the learned policy visits states absent from demonstrations. Dataset Aggregation (DAgger) addresses this by iteratively collecting expert labels on states induced by the learned policy [R8]. AlphaStar's use of supervised pretraining from human games reinforces the value of demonstrations for complex RTS domains [R1].

For Hermes, demonstrations could come from curated successful Hermes windows, private scripted teachers, or community-inspired deterministic strategy traces. Because community bot code may have license/compatibility constraints, imitation should copy behavioral labels or high-level patterns, not unreviewed source code.

### 2.5 Heuristic evolution, genetic search, and strategy-weight tuning

Evolutionary and population-based methods have a long history in game AI and can optimize parameters without differentiable models. Population Based Training (PBT) combines online training with periodic exploit/explore of hyperparameters and weights [R9]. In Screeps, a conservative variant is useful for strategy knobs: maintain candidate weight vectors, evaluate them offline/private, promote only when lexicographic KPIs improve, and keep rollback metadata.

This is the strongest near-term learning family because Hermes already uses heuristic scoring and evidence-backed reviews. It can evolve construction, expansion, remote-mining, and defense weights without replacing safe deterministic executors.

### 2.6 Contextual bandits

Contextual bandits choose an action from context and observe reward for that action, with standard approaches such as LinUCB and exploration/exploitation algorithms studied for web/news recommendation and other online decision problems [R10]-[R11]. Bandits are much simpler than full RL because they ignore long delayed state transitions, but many Screeps strategy choices can be reframed as bounded knob selection over fixed review windows.

Hermes-compatible use cases:

- choose among construction-priority presets per room phase;
- choose expansion-candidate score weights for a private scenario batch;
- choose repair/rampart threshold presets under observed threat/economy context;
- select remote-mining enablement policy under hostiles/source/path context.

Bandits should run first in shadow/offline mode, then possibly as low-frequency bounded recommendations reviewed by issue/PR evidence.

### 2.7 Curriculum learning

Curriculum learning trains agents on tasks ordered from simple to difficult, improving optimization for complex objectives [R12]. Screeps strategy naturally decomposes into curricula: single-room survival, RCL growth, remote mining, reservation, claim/bootstrap, defense, multi-room logistics, then offense.

Private-server scenario design should follow this order and mirror the project vision. A learned policy that cannot reliably survive and hold territory in simple scenarios must not be evaluated for combat optimization.

### 2.8 Self-play and opponent diversity

Self-play can create strong agents in adversarial games; AlphaStar used a league of agents to address exploitability and non-stationarity [R1], and OpenAI Five used large-scale self-play [R2]. In Screeps, self-play is attractive for defense/offense and expansion races but expensive and risky. The official MMO already contains non-stationary opponents and irreversible consequences, so self-play should be restricted to private-server worlds with scripted baselines and snapshots of older Hermes policies.

### 2.9 Hierarchical RL and options

Hierarchical RL decomposes control into high-level options/subgoals and lower-level controllers. The options framework formalizes temporally extended actions [R13], and older hierarchical ideas such as feudal reinforcement learning separate manager and worker levels [R14]. This matches Screeps architecture well: a high-level policy could choose strategic intents while deterministic spawn/creep/task code enforces safety.

Hermes should target hierarchical RL before end-to-end control. The safe boundary is: learned high-level goal selection may propose; deterministic code validates prerequisites, resource budgets, CPU budgets, and rollback conditions before execution.

### 2.10 Model-based planning and search

Model-based planning learns or encodes environment dynamics and uses search to evaluate actions. Monte Carlo Tree Search surveys cover game-tree search principles [R15], while MuZero shows learned models can support planning without hand-coded rules in several games [R16]. For Screeps, exact simulation of the official MMO is infeasible because opponents and server internals are not controlled, but narrow model-based planning is useful for logistics, spawn scheduling, expansion timing, and private scenarios.

Near-term model-based work should use deterministic reducers and what-if planners around known mechanics, not learned world models for the entire MMO.

## 3. Method comparison for Hermes

| Method | Screeps fit | Main benefit | Main risk | Recommended phase |
| --- | --- | --- | --- | --- |
| Heuristic evolution / weight search | Very high | Works with current scoring, transparent, easy rollback | Overfits noisy windows; can entrench local optima | Start now after registry/evaluator |
| Contextual bandits | High for bounded choices | Simple exploration/exploitation over presets | Delayed rewards violate bandit assumptions; unsafe if online too soon | Offline/shadow first, bounded live recommendations later |
| Offline RL | Medium later | Learns from accumulated traces without live exploration | Dataset bias, OOD actions, reward misspecification | After artifact schema + private validation |
| Imitation / behavior cloning | Medium | Bootstraps from curated good traces or scripted teachers | Compounding errors; license/pattern copying concerns | Private scenarios and high-level labels |
| Self-play | Medium for combat/expansion race | Opponent diversity and adversarial robustness | Compute cost; private/offical transfer gap | Long-term private-server league only |
| Population Based Training | Medium-high for knobs | Evolves parameters and schedules | Online PBT unsafe in MMO; noisy promotion | Offline/private populations after scenarios |
| Curriculum learning | High as scenario method | Orders survival→territory→resources→combat | Bad curriculum can overfit toy worlds | Use for scenario suite from the start |
| Hierarchical RL | High long-term | Keeps learned policy at strategic layer | Interface design and validation complexity | Long-term after deterministic executors mature |
| Model-based planning | High for narrow subproblems | Interpretable what-if evaluation | Full-world model impossible; opponent uncertainty | Start with deterministic private planners |
| End-to-end online RL | Very low now | Theoretically broad automation | Direct room loss, CPU waste, Memory corruption | Explicitly prohibited for official MMO |

## 4. Recommended architecture

### 4.1 Strategy registry

Create a versioned registry of strategy models and bounded knobs. Each registry entry should record:

- strategy ID/version and owning GitHub issue/PR;
- supported room phases and contexts;
- knob names, min/max bounds, defaults, and safety invariants;
- reward/evaluator version;
- rollout status: proposed, shadow, private, canary, active, rolled back;
- evidence links: artifacts, private scenario reports, PRs, runtime summaries;
- rollback plan and stop conditions.

### 4.2 Artifact pipeline

Every learning/evaluation step should consume immutable artifacts rather than ad hoc prose:

1. **Runtime summary:** current room, CPU, bucket, spawn queue, creeps, controller, storage, alerts.
2. **Room snapshot:** owned/remote structures, construction, resources, hostiles, exits, path features.
3. **Event log extraction:** attacks, deaths/destruction, controller attacks/upgrades, construction, harvest/repair/build events where available.
4. **Memory artifacts:** strategy version, task queues, role/task state, experiment assignment, schema version.
5. **Deploy metadata:** code version, PR/commit, feature flags, rollback point.
6. **KPI reducer output:** lexicographic territory/resources/kills/reliability deltas over fixed windows.

### 4.3 Offline evaluator

The evaluator should replay saved observations and score candidate strategy models without mutating live state. It should answer:

- Would a candidate have ranked expansion/remote/construction choices differently?
- Did the different choice align with later KPI outcomes?
- Which contexts lack coverage or produce conflicting evidence?
- Does the candidate violate hard guardrails such as CPU, downgrade risk, spawn recovery, or territory loss?

Offline evaluation cannot prove live safety, but it filters bad candidates before private-server work.

### 4.4 Private-server scenario suite

The private suite should run repeatable scenarios using the official private server ecosystem [S7] and scenario scripts. Curriculum order:

1. single-room bootstrap and spawn recovery;
2. controller/RCL growth and construction priority;
3. emergency recovery after worker loss;
4. remote mining with path/logistics pressure;
5. reservation and claim/bootstrap;
6. static hostile defense and rampart/tower readiness;
7. adversarial raids from scripted or older-policy opponents;
8. multi-room resource routing.

Each scenario records seed/config, strategy version, KPI reducer output, CPU/memory profile, pass/fail guardrails, and rollback notes.

### 4.5 A/B shadow evaluation

Before any official MMO influence, candidate and incumbent strategy models should both run in shadow against the same live observations. Only the incumbent may choose actions. The candidate emits proposed rankings and predicted KPI effects. Review compares candidate proposals with subsequent outcomes and private scenario evidence.

### 4.6 Bounded strategy knobs

When a candidate graduates beyond shadow, its live authority should be limited to bounded knobs with deterministic validation. Examples:

- construction priority weights within fixed min/max;
- expansion candidate score weights with hard filters for hostile/claim/GCL constraints;
- repair/rampart floor presets capped by energy and CPU budgets;
- remote-mining enable/disable recommendation gated by hostile and logistics checks;
- defense posture preset selection that cannot disable emergency safety logic.

A knob update must be low-frequency, logged, reversible, tied to a strategy version, and subordinated to the lexicographic reward order.

## 5. Safety policy

1. **No unvalidated learned policy may directly influence official MMO actions.**
2. **Offline artifacts first:** all candidates start as recommendations against saved data.
3. **Private scenarios second:** candidate policies must pass relevant curriculum scenarios with reliability and territory guardrails.
4. **A/B shadow third:** candidates propose decisions on live observations while incumbent code acts.
5. **Bounded knobs only:** initial live influence is limited to approved min/max strategy parameters; deterministic validators may veto any proposal.
6. **Rollback always available:** every strategy version has a previous stable version, stop condition, and issue/PR evidence.
7. **Reward order immutable:** kills, resource hoarding, CPU micro-optimizations, or short-term score cannot compensate for territory loss or reliability failure.
8. **Human/agent review contract:** changes flow through GitHub issues/PRs/project fields; no cron creates hidden jobs or unscheduled online experiments.

## 6. Experimental plan

### Phase 0 — Paper closure and backlog correction

- This paper replaces the scaffold created under #232 and closes the corrected research scope under #262.
- PR description must explicitly state that #232 completed vision/scaffold only, not full autoresearch.

### Phase 1 — Non-RL strategy evolution foundation

Deliver a strategy registry and offline/shadow evaluator for existing heuristic models. Verification:

- docs/schema for strategies and KPI reducer fields;
- deterministic tests for lexicographic scoring;
- replay of at least two saved runtime artifacts;
- no production behavior change until a separate reviewed PR.

Rollback: registry/evaluator is passive; disabling it removes reports without changing bot behavior.

### Phase 2 — Private scenario suite

Create private-server scenarios for construction priority and expansion/remote planning. Verification:

- reproducible seeds/configs;
- KPI output with territory/resources/kills/reliability fields;
- incumbent baseline recorded;
- failure artifacts archived.

Rollback: scenarios do not deploy to official MMO.

### Phase 3 — Bandit / heuristic tuner

Run contextual-bandit or evolutionary tuning over bounded construction/expansion weights in offline/private/shadow mode. Verification:

- candidate weights remain within registry bounds;
- evaluator shows lexicographic improvement or explicit uncertainty;
- private scenarios pass guardrails;
- shadow mode shows no predicted territory/reliability regression.

Rollback: keep incumbent strategy version as active; candidate remains proposed.

### Phase 4 — Offline RL / imitation prototypes

Use logged artifacts and private traces to train recommendation-only models for high-level decisions. Verification:

- dataset cards document coverage, code versions, and reward construction;
- OOD detection or conservative evaluation reports uncertainty;
- private scenarios beat incumbent on earlier reward layers without guardrail failures.

Rollback: model remains offline; no live action path exists.

### Phase 5 — Hierarchical RL pilot

Allow a learned high-level policy to propose goals such as remote target, construction preset, or defense posture in private scenarios. Deterministic code validates and executes. Verification:

- goal interface is explicit and typed;
- policy cannot issue raw creep intents;
- private scenario win criteria preserve territory > resources > kills;
- A/B shadow evidence supports bounded live canary consideration.

Rollback: strategy registry switches active policy back to deterministic incumbent.

## 7. Roadmap decomposition and downstream issue recommendations

### 7.1 Near-term issue: strategy registry + shadow evaluator

**Title:** P1: Gameplay Evolution: strategy registry and shadow evaluator for bounded strategy models

**Scope:** implement a passive registry for strategy versions/knobs and a replay/shadow evaluator that compares incumbent vs candidate rankings for construction, expansion, remote, and defense decisions without changing live actions.

**Acceptance criteria:**

- strategy registry schema includes version, bounds, evidence links, rollout status, and rollback fields;
- KPI reducer uses lexicographic reliability/territory/resources/kills ordering;
- evaluator can process saved runtime summary/room snapshot artifacts and produce candidate-vs-incumbent diffs;
- tests prove later rewards cannot compensate for territory/reliability failure;
- feature is passive by default and safe to disable.

**Rollback/safety:** no live action path; remove/disable evaluator if reports are noisy.

### 7.2 Near-term issue: private scenario suite for strategy evaluation

**Title:** P1: Gameplay Evolution: private-server scenario suite for construction and expansion strategies

**Scope:** create reproducible private-server scenarios for single-room bootstrap, construction priority, remote mining, and claim/bootstrap evaluation.

**Acceptance criteria:**

- scenarios have deterministic config/seed and documented expected baseline;
- output includes KPI reducer artifact and CPU/runtime safety metrics;
- incumbent strategy baseline is recorded before candidate comparison;
- failures produce artifacts suitable for GitHub issue evidence.

**Rollback/safety:** private only; no official MMO deployment path.

### 7.3 Near-term issue: bounded bandit/heuristic tuner prototype

**Title:** P2: Gameplay Evolution: offline bounded tuner for construction/expansion weights

**Scope:** prototype contextual-bandit or evolutionary tuning over registry-approved knobs using offline artifacts and private scenarios.

**Acceptance criteria:**

- tuner cannot emit values outside registry bounds;
- recommendations include confidence/coverage and exact evidence artifacts;
- candidate must beat incumbent lexicographically in private scenarios before shadow consideration;
- no automatic official MMO effect.

**Rollback/safety:** discard candidate strategy version; incumbent remains active.

### 7.4 Long-term issue: offline RL / imitation recommendation model

**Title:** P3: Gameplay Evolution: offline RL and imitation recommendation prototype for high-level strategy goals

**Scope:** train recommendation-only models from curated Hermes/private traces for high-level strategy choices, not raw creep intents.

**Acceptance criteria:**

- dataset card documents source windows, strategy versions, reward labels, and known bias;
- model outputs only typed high-level recommendations;
- conservative/OOD uncertainty is reported;
- private scenario and A/B shadow results beat incumbent on territory-first ordering;
- deterministic validators can reject every recommendation.

**Rollback/safety:** model stays offline/shadow unless a later PR explicitly promotes bounded knobs.

### 7.5 Long-term issue: hierarchical RL private pilot

**Title:** P3: Gameplay Evolution: hierarchical RL private-server pilot for strategic goal selection

**Scope:** evaluate an options-style policy in private scenarios where learned high-level goals are executed by deterministic safe controllers.

**Acceptance criteria:**

- formal goal/action interface with hard safety validators;
- curriculum scenarios for survival, expansion, resources, and combat;
- no direct tick-level action policy;
- private results and shadow evidence satisfy reliability and territory gates before any live proposal.

**Rollback/safety:** switch registry active policy back to deterministic incumbent; learned policy has no direct official MMO authority.

## 8. Decision summary

1. **Recommended immediate direction:** implement passive strategy registry and shadow/offline evaluator before any RL code.
2. **Recommended first learning method:** bounded heuristic evolution/contextual-bandit tuning for construction and expansion weights.
3. **Recommended data work:** standardize runtime summary, room snapshot, event-log, Memory, deploy, and KPI reducer artifacts.
4. **Recommended validation path:** offline artifacts → private-server curriculum scenarios → A/B shadow evaluation → bounded strategy knobs.
5. **Recommended RL posture:** offline RL, imitation, self-play/PBT, and hierarchical RL are research/long-term implementation tracks, not current official MMO controllers.
6. **Non-negotiable constraint:** every reward, score, rollout, and issue must preserve territory > resources > kills, with reliability as a hard floor.

## References

### Screeps official and project sources

- [S1] Screeps official game loop documentation: https://docs.screeps.com/game-loop.html
- [S2] Screeps official CPU limit documentation: https://docs.screeps.com/cpu-limit.html
- [S3] Screeps official API reference: https://docs.screeps.com/api/
- [S4] Screeps official Memory documentation: https://docs.screeps.com/global-objects.html#Memory-object
- [S5] Screeps official RawMemory documentation: https://docs.screeps.com/api/#RawMemory
- [S6] Screeps official control/controller documentation: https://docs.screeps.com/control.html
- [S7] Screeps private server repository: https://github.com/screeps/screeps
- [S8] Hermes project vision: `docs/ops/project-vision.md`
- [S9] Hermes gameplay evaluation framework: `docs/research/2026-04-27-gameplay-evaluation-framework.md`
- [S10] Hermes Screeps mechanics/API constraints note: `docs/research/2026-04-25-screeps-world-mechanics-and-api-constraints.md`

### Screeps community sources

- [C1] Overmind project page: https://bencbartlett.com/projects/overmind/
- [C2] Overmind repository: https://github.com/bencbartlett/Overmind
- [C3] Ben Bartlett, "Screeps #1: Overlord overload": https://bencbartlett.com/blog/screeps-1-overlord-overload/
- [C4] Ben Bartlett, "Screeps #4: Hauling is (NP-)hard": https://bencbartlett.com/blog/screeps-4-hauling-is-np-hard/
- [C5] Ben Bartlett, "Screeps #5: Evolution": https://bencbartlett.com/blog/screeps-5-evolution/
- [C6] Ben Bartlett, "Screeps #6: Verifiably refreshed": https://bencbartlett.com/blog/screeps-6-verifiably-refreshed/
- [C7] ScreepsPlus ecosystem: https://screepspl.us/
- [C8] TooAngel Screeps bot repository: https://github.com/TooAngel/screeps
- [C9] TooAngel stats implementation: https://github.com/TooAngel/screeps/blob/master/src/brain_stats.js
- [C10] Overmind stats module: https://github.com/bencbartlett/Overmind/blob/master/src/stats/stats.ts

### Research sources

- [R1] Vinyals et al., "Grandmaster level in StarCraft II using multi-agent reinforcement learning", Nature 2019: https://www.nature.com/articles/s41586-019-1724-z
- [R2] OpenAI, "Dota 2 with Large Scale Deep Reinforcement Learning" / OpenAI Five: https://arxiv.org/abs/1912.06680 and https://openai.com/research/openai-five/
- [R3] Santiago Ontañón, "The Combinatorial Multi-Armed Bandit Problem and its Application to Real-Time Strategy Games" / µRTS project page: https://sites.google.com/site/micrortsaicompetition/ and https://github.com/santiontanon/microrts
- [R4] Ontañón et al., "A Survey of Real-Time Strategy Game AI Research and Competition in StarCraft", IEEE TCIAIG 2013: https://doi.org/10.1109/TCIAIG.2013.2286295
- [R5] Levine et al., "Offline Reinforcement Learning: Tutorial, Review, and Perspectives on Open Problems", arXiv 2020: https://arxiv.org/abs/2005.01643
- [R6] Kumar et al., "Conservative Q-Learning for Offline Reinforcement Learning", NeurIPS 2020: https://arxiv.org/abs/2006.04779
- [R7] Chen et al., "Decision Transformer: Reinforcement Learning via Sequence Modeling", NeurIPS 2021: https://arxiv.org/abs/2106.01345
- [R8] Ross, Gordon, and Bagnell, "A Reduction of Imitation Learning and Structured Prediction to No-Regret Online Learning" (DAgger), AISTATS 2011: https://proceedings.mlr.press/v15/ross11a.html
- [R9] Jaderberg et al., "Population Based Training of Neural Networks", arXiv 2017: https://arxiv.org/abs/1711.09846
- [R10] Li et al., "A Contextual-Bandit Approach to Personalized News Article Recommendation" (LinUCB), WWW 2010: https://arxiv.org/abs/1003.0146
- [R11] Langford and Zhang, "The Epoch-Greedy Algorithm for Multi-armed Bandits with Side Information", NeurIPS 2007: https://papers.nips.cc/paper_files/paper/2007/hash/4b04a686b0ad13dce35fa99fa4161c65-Abstract.html
- [R12] Bengio et al., "Curriculum Learning", ICML 2009: https://dl.acm.org/doi/10.1145/1553374.1553380
- [R13] Sutton, Precup, and Singh, "Between MDPs and Semi-MDPs: A Framework for Temporal Abstraction in Reinforcement Learning", Artificial Intelligence 1999: https://www.sciencedirect.com/science/article/pii/S0004370299000521
- [R14] Dayan and Hinton, "Feudal Reinforcement Learning", NeurIPS 1992: https://papers.nips.cc/paper_files/paper/1992/hash/d14220ee66aeec73c49038385428ec4c-Abstract.html
- [R15] Browne et al., "A Survey of Monte Carlo Tree Search Methods", IEEE TCIAIG 2012: https://doi.org/10.1109/TCIAIG.2012.2186810
- [R16] Schrittwieser et al., "Mastering Atari, Go, Chess and Shogi by Planning with a Learned Model" (MuZero), Nature 2020: https://www.nature.com/articles/s41586-020-03051-4
