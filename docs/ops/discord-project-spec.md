# Screeps Discord Project Specification

> Canonical coordination spec for the Screeps: World project.
> This document defines the Discord structure that all future research, decisions, tasks, and runtime updates must follow.

## 1. Purpose

The Discord server is the project’s operating surface for:
- research collection
- decision tracking
- roadmap planning
- active task coordination
- development logs
- runtime monitoring
- runtime alerts

Because the project has only two participants, the structure is intentionally minimal and should not be over-engineered.

---

## 2. Roles

Keep the role set minimal:

### Required roles
- `Owner` — the human project owner and final decision authority
- `Bot` — the automated assistant / project operator

### Optional role
- `Observer` — only if you later want a read-only audience

### Role policy
- Do not introduce extra roles unless there is a concrete operational need.
- Avoid role bloat.
- Prefer simple permissions over complex role hierarchies.

---

## 3. Channel structure

Create the following channels in this order:

1. `#project-vision`
2. `#decisions`
3. `#research-notes`
4. `#roadmap`
5. `#task-queue`
6. `#dev-log`
7. `#runtime-summary`
8. `#runtime-alerts`

### Channel responsibilities

#### `#project-vision`
- Project mission
- Scope boundaries
- Principles
- Success criteria

#### `#decisions`
- Final decisions only
- Architecture choices
- Tooling choices
- Deployment choices
- Major tradeoffs

#### `#research-notes`
- Source links
- API findings
- Experiment notes
- Working observations

#### `#roadmap`
- Phase planning
- Milestones
- Exit criteria
- Priority ordering

#### `#task-queue`
- Active tasks only
- Owner
- Completion criteria
- Blockers

#### `#dev-log`
- Implementation progress
- Files changed
- Test results
- Open issues

#### `#runtime-summary`
- Periodic status snapshots
- CPU / bucket / tick state
- Room / creep / spawn summary
- High-level health indicators

#### `#runtime-alerts`
- Exceptions
- CPU spikes
- Memory risk
- Spawn deadlocks
- Resource crises
- Combat / hostile events
- Deployment failures

---

## 4. Permission model

Because the server has only two participants, permissions should be simple.

### Recommended read access
- `Owner`: yes everywhere
- `Bot`: yes everywhere
- `Observer`: yes if created

### Recommended write access
- `#project-vision`: Owner, Bot
- `#decisions`: Owner, Bot
- `#research-notes`: Owner, Bot
- `#roadmap`: Owner, Bot
- `#task-queue`: Owner, Bot
- `#dev-log`: Owner, Bot
- `#runtime-summary`: Bot primarily; Owner may manually add notes
- `#runtime-alerts`: Bot primarily; Owner may annotate manually if needed

### Important rule
- Do not make the server dependent on a complicated permission tree.
- The point is clarity, not security theater.

---

## 5. Operating rules

### 5.1 Separation of concerns
- Research goes to `#research-notes`
- Final decisions go to `#decisions`
- Roadmaps go to `#roadmap`
- Current work goes to `#task-queue`
- Development progress goes to `#dev-log`
- Periodic state goes to `#runtime-summary`
- Errors and emergencies go to `#runtime-alerts`

### 5.2 Noise control
- Do not post long debates in `#decisions`.
- Do not post raw logs in `#research-notes`.
- Do not post tasks in `#roadmap`.
- Do not post summary data in `#runtime-alerts`.
- Keep alert messages short and actionable.

### 5.3 Traceability
Every important choice should leave a trail:
1. research note
2. decision
3. task entry
4. dev log entry
5. runtime observation

### 5.4 Minimalism
- Use the smallest channel and role set that still supports the workflow.
- Do not add extra categories, roles, or channels unless we know why they exist.

---

## 6. Message templates

### Research note
```text
[Source] URL or document name
[Finding] factual finding
[Implication] what it means for the project
[Confidence] high / medium / low
```

### Decision
```text
[Decision] ...
[Context] ...
[Options considered] ...
[Chosen option] ...
[Reason] ...
[Follow-up] ...
```

### Task
```text
[Task ID] short-id
[Goal] one sentence
[Owner] Owner / Bot
[Done when] explicit acceptance criterion
[Blockers] if any
```

### Dev log
```text
[Change] what changed
[Files] relevant files
[Test] what was run
[Result] outcome
[Next] next step
```

### Runtime summary
```text
[Shard] shard0
[Tick] 12345678
[CPU] 11.2 / 20, bucket 9200
[Rooms] 3 owned, 1 remote, 0 hostile
[Spawns] 4 active
[Alerts] none
[Highlights] storage below threshold in W8N3
```

### Runtime alert
```text
[Severity] high
[Shard] shard1
[Room] W8N3
[Issue] tower energy empty
[Impact] room defense degraded
[Action] request refill / debug supply chain
```

---

## 7. Pinned message policy

Each channel should have a pinned message that states:
- what belongs there
- what does not belong there
- the preferred message format

Pinned messages should be short and should not duplicate the whole project spec.

---

## 8. Required setup order

1. Create the roles (`Owner`, `Bot`)
2. Create the eight channels
3. Set the permissions
4. Add the pinned message in each channel
5. Start using the channel contract for all future Screeps work

---

## 9. How future Screeps work must use this structure

All future work should be routed through the Discord structure as follows:

- Any new research starts in `#research-notes`
- Any choice that changes direction ends up in `#decisions`
- Any multi-step work is tracked in `#task-queue`
- Any implementation update is summarized in `#dev-log`
- Any operational state is posted in `#runtime-summary`
- Any failure or emergency is posted in `#runtime-alerts`

This means the Discord structure is not optional; it is the project’s workflow contract.

---

## 10. Status

As of this document, the Discord structure has been defined as the canonical project coordination format. Future planning and Screeps research should assume this layout unless explicitly revised.
