# Screeps Discord Server Configuration

> Goal: turn Discord into the project’s operating system for research, decisions, implementation coordination, runtime monitoring, and release management.
> Scope: this document defines the channel layout, channel purpose, message conventions, bot outputs, and operating workflow that future Screeps tasks should follow.

## 1. Design principles

1. **One channel, one purpose**
   - Each channel should answer one question only.
   - Avoid mixing research, decisions, implementation logs, and runtime alerts in the same place.

2. **Decision channels are append-only**
   - Final decisions should be easy to find and hard to bury.
   - Prefer short decision posts with links to supporting analysis.

3. **Operational channels are noisy by design**
   - Runtime logs and alerts should be isolated so they do not contaminate research or planning discussion.

4. **Every thread has a lifecycle**
   - Research thread → decision thread → implementation thread → runtime observation thread → postmortem.

5. **Bot output must be structured**
   - Summaries should be concise and consistent.
   - The bot should emit predictable templates so humans can scan quickly.

---

## 2. Recommended server layout

### Category A — Governance

#### `#project-vision`
Purpose:
- Project mission
- Long-term direction
- Scope boundaries
- What we are trying to optimize for

Use for:
- High-level objectives
- “What kind of Screeps bot are we building?”
- Success criteria

Do not use for:
- Implementation details
- Debug logs
- Experimental ideas

#### `#decisions`
Purpose:
- Finalized decisions only

Use for:
- Language choice
- Architecture choice
- Deployment choice
- Module boundaries
- Release criteria

Recommended post format:
- `Decision:`
- `Context:`
- `Options considered:`
- `Chosen option:`
- `Reason:`
- `Follow-up:`

#### `#open-questions`
Purpose:
- Unresolved questions that block decisions

Use for:
- Questions that need research
- Questions that require user input
- Decision tradeoffs not yet settled

---

### Category B — Research

#### `#research-index`
Purpose:
- Links to all research artifacts
- Index of sources and notes

Use for:
- New source links
- Summary bullets from official docs
- Cross-references to docs files in the repo

#### `#research-notes`
Purpose:
- Working research notes

Use for:
- Findings from official docs
- Findings from community projects
- Comparisons between approaches

Do not use for:
- Final conclusions

#### `#references`
Purpose:
- Canonical source dump

Use for:
- URLs
- API docs references
- GitHub repo links
- Important excerpts and citations

---

### Category C — Planning

#### `#roadmap`
Purpose:
- Multi-stage plan tracking

Use for:
- Phase 1 / Phase 2 / MVP / V1 / V2 planning
- Milestones
- Exit criteria

#### `#task-queue`
Purpose:
- Active work queue

Use for:
- Current tasks
- Task assignment
- Priority changes

Suggested task format:
- `ID:` short stable identifier
- `Owner:` human or bot
- `Goal:` one sentence
- `Done when:` explicit acceptance criterion
- `Blockers:` if any

#### `#experiments`
Purpose:
- Prototype ideas and failed attempts

Use for:
- A/B testing strategies
- Prototype results
- Dead ends worth remembering

---

### Category D — Implementation

#### `#dev-log`
Purpose:
- Engineering progress updates

Use for:
- Code changes made
- Test results
- Refactors
- What changed since the last update

#### `#build-status`
Purpose:
- Build / compile / deploy feedback

Use for:
- Compile success or failure
- Bundle size changes
- Deployment status
- Version tags

#### `#code-review`
Purpose:
- Review discussion

Use for:
- Review requests
- Review findings
- Approval / rework notes

#### `#change-log`
Purpose:
- Stable history of user-visible changes

Use for:
- Release notes
- Version summaries
- Major architecture changes

---

### Category E — Runtime / Operations

#### `#runtime-summary`
Purpose:
- Periodic state snapshots from the bot

Suggested bot output:
- Tick number
- CPU used / CPU limit / bucket
- GCL / RCL summary
- Number of creeps
- Room health summary
- Main active tasks

#### `#runtime-alerts`
Purpose:
- Alert-only channel

Use for:
- Exceptions
- Spike in CPU usage
- Memory overflow risk
- Spawn deadlock
- No-op loops
- Lost room / defensive breach / hostile detection

#### `#deploy-alerts`
Purpose:
- Deployment notifications

Use for:
- Successful push
- Failed push
- Rollback notice
- New build hash

#### `#combat-alerts`
Purpose:
- War/defense status

Use for:
- Invasion detection
- Tower underload/overload
- Hostile creep sightings
- Attack plans
- Reinforcement requests

#### `#economy-alerts`
Purpose:
- High-level economy monitoring

Use for:
- Energy shortages
- Storage/terminal imbalance
- Market trade events
- Resource bottlenecks

---

### Category F — Archive / Reference

#### `#archive`
Purpose:
- Finalized, non-active threads and resolved discussions

Use for:
- Closed decisions
- Completed experiments
- Retired plans

#### `#readme`
Purpose:
- Pinned orientation for new contributors

Use for:
- Project overview
- Where to post what
- How to use channels
- Link to repo docs

---

## 3. Minimal channel set for day 1

If we want to keep the server lean at the beginning, start with these 8 channels:

1. `#project-vision`
2. `#decisions`
3. `#research-notes`
4. `#roadmap`
5. `#task-queue`
6. `#dev-log`
7. `#runtime-summary`
8. `#runtime-alerts`

Optional add-ons once the project grows:
- `#build-status`
- `#deploy-alerts`
- `#combat-alerts`
- `#economy-alerts`
- `#code-review`
- `#archive`

---

## 4. Role model

### Recommended roles

#### `Owner`
- Final decision authority
- Can approve architecture and release choices

#### `Architect`
- Maintains system design and module boundaries
- Proposes and revises implementation direction

#### `Developer`
- Implements code and runs tests

#### `Observer`
- Read-only participation for people who want updates without noise

#### `Bot`
- Publishes runtime summaries, alerts, and deployment notices

### Permission suggestions

- `#decisions`: posting restricted to Owner + Architect; others may comment in threads
- `#runtime-alerts`: posting restricted to Bot
- `#runtime-summary`: posting restricted to Bot
- `#task-queue`: posting to Owner + Architect + Developer
- `#research-notes`: posting to working contributors

---

## 5. Message conventions

### Research post template

```text
[Source] URL or doc name
[Finding] short factual statement
[Implication] what this means for us
[Confidence] high / medium / low
```

### Decision post template

```text
[Decision] ...
[Why] ...
[Options] ...
[Follow-up] ...
```

### Task post template

```text
[Task ID] short-id
[Goal] one sentence
[Owner] person or bot
[Done when] explicit result
[Notes] blockers or links
```

### Runtime summary template

```text
[Shard] shard0
[Tick] 12345678
[CPU] 11.2 / 20, bucket 9200
[Rooms] 3 owned, 1 remote, 0 hostile
[Spawns] 4 active
[Alerts] none
[Highlights] storage below threshold in W8N3
```

### Runtime alert template

```text
[Severity] high
[Shard] shard1
[Room] W8N3
[Issue] tower energy empty
[Impact] room defense degraded
[Action] request refill / debug supply chain
```

---

## 6. Workflow we should use going forward

### Phase 1 — Research
- Post raw findings into `#research-notes`
- Record source URLs in `#references`
- When a question blocks progress, move it to `#open-questions`

### Phase 2 — Decision
- Summarize the research in `#decisions`
- Record the chosen option and why it won
- Pin or archive the decision for later reference

### Phase 3 — Implementation
- Move the active task to `#task-queue`
- Track implementation progress in `#dev-log`
- Use `#build-status` for compile/deploy feedback

### Phase 4 — Runtime
- Bot posts summaries to `#runtime-summary`
- Bot posts incidents to `#runtime-alerts`
- Major events can be mirrored to `#combat-alerts` or `#economy-alerts`

### Phase 5 — Review
- Summarize the outcome in `#change-log`
- Close tasks
- Move obsolete threads to `#archive`

---

## 7. Bot requirements

The Discord bot should be able to publish the following classes of messages:

1. **Periodic summaries**
   - Tick-based or interval-based health snapshots

2. **Event alerts**
   - Errors, crashes, hostile activity, resource shortage, deploy failures

3. **Milestone notifications**
   - Spawn created, new room claimed, new system unlocked, build passed

4. **Decision mirrors**
   - Optional repost of finalized decisions for visibility

5. **Manual command responses**
   - “show current status”
   - “summarize last 100 ticks”
   - “list active alarms”

Recommended bot behavior:
- Messages should be short by default.
- Detailed diagnostics should be attached or linked, not dumped inline.
- Each alert should include a stable identifier for cross-reference.

---

## 8. What I recommend we do first

### Minimum viable Discord configuration

Create these channels first:
- `#project-vision`
- `#decisions`
- `#research-notes`
- `#roadmap`
- `#task-queue`
- `#dev-log`
- `#runtime-summary`
- `#runtime-alerts`

Create these roles first:
- `Owner`
- `Architect`
- `Developer`
- `Observer`
- `Bot`

Then pin a short “Where to post what” message in `#project-vision` or `#readme`.

---

## 9. Open questions

1. Do you want a **lean server** first, or a **fully separated ops server** from day one?
2. Will there be multiple human contributors, or just you plus the bot initially?
3. Do you want the bot to post **raw logs**, or only **summaries + alerts**?
4. Should we use **threads per task**, or keep each task in its own top-level channel post?

---

## 10. Repo linkage

This document should be treated as the canonical reference for future Screeps tasks.
Future docs and implementation notes should align to this channel layout.
