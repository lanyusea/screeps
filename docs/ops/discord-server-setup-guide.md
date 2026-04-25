# Discord Server Setup Guide for Screeps

> Purpose: provide a concrete, administrator-facing setup guide for the Screeps project Discord server.
> This document is intended to be used before implementation work continues.

## 1. Goal

Turn Discord into the operational backbone for the Screeps project so that all future work is organized around:
- research
- decisions
- task execution
- runtime monitoring
- deployment tracking

This guide defines the initial server structure and the configuration rules that should be followed consistently.

---

## 2. Recommended minimal server structure

### Roles
Create these roles first:

1. `Owner`
   - Final authority for project direction
   - Approves major decisions
   - Can override any blocked step

2. `Architect`
   - Owns system design and module boundaries
   - Proposes technical direction
   - Reviews plans and architecture changes

3. `Developer`
   - Implements code
   - Runs tests and deploys changes
   - Writes dev logs

4. `Observer`
   - Read-only / low-noise access
   - Can follow progress without interfering

5. `Bot`
   - Posts runtime summaries
   - Posts alerts
   - Posts deployment status

### Channels
Create these channels first:

1. `#project-vision`
   - High-level mission and scope
   - What success looks like
   - Core principles

2. `#decisions`
   - Final decisions only
   - Architecture decisions
   - Language / tooling decisions
   - Deployment decisions

3. `#research-notes`
   - Working findings from docs, experiments, and references
   - No final conclusions here

4. `#roadmap`
   - Milestones and phase planning
   - Stage gates and exit criteria

5. `#task-queue`
   - Current tasks and ownership
   - Short actionable task items

6. `#dev-log`
   - Implementation progress
   - What changed, what was tested, what still needs work

7. `#runtime-summary`
   - Periodic bot health snapshots
   - Tick / CPU / bucket / creep / room state summaries

8. `#runtime-alerts`
   - Error-only channel
   - Exceptions, CPU spikes, deadlocks, missing resources, hostile events

---

## 3. Permission model

### Suggested channel permissions

#### `#project-vision`
- Everyone can read
- Posting allowed for Owner / Architect

#### `#decisions`
- Everyone can read
- Posting restricted to Owner / Architect
- Comments should happen in threads or linked follow-up posts

#### `#research-notes`
- Everyone can read
- Posting allowed for working contributors

#### `#roadmap`
- Everyone can read
- Posting allowed for Owner / Architect

#### `#task-queue`
- Everyone can read
- Posting allowed for Owner / Architect / Developer

#### `#dev-log`
- Everyone can read
- Posting allowed for Developer

#### `#runtime-summary`
- Everyone can read
- Posting restricted to Bot

#### `#runtime-alerts`
- Everyone can read
- Posting restricted to Bot

### Why this model works
- It keeps the decision trail clean.
- It keeps runtime noise out of planning channels.
- It makes it obvious where to look for status and where to look for problems.

---

## 4. Minimal pinned message for each channel

### `#project-vision`
```text
This channel defines the project mission and scope.
Post here only if you are clarifying what this Screeps project is trying to achieve.
```

### `#decisions`
```text
This channel is for final decisions only.
Use this format:
- Decision
- Context
- Options considered
- Chosen option
- Reason
- Follow-up
```

### `#research-notes`
```text
Use this channel for source findings, experiments, and working notes.
Do not post final decisions here.
```

### `#roadmap`
```text
Use this channel for phases, milestones, and exit criteria.
Keep the roadmap short and actionable.
```

### `#task-queue`
```text
Use this channel for active tasks only.
Each task should include:
- ID
- Goal
- Owner
- Done when
- Blockers
```

### `#dev-log`
```text
Use this channel for implementation updates and verification notes.
Post what changed, how it was tested, and what remains.
```

### `#runtime-summary`
```text
Bot-only channel.
Use this for periodic status snapshots.
Keep messages short and structured.
```

### `#runtime-alerts`
```text
Bot-only channel.
Use this for errors, spikes, deadlocks, and urgent game events.
Alert messages should include severity, shard, room, issue, impact, and action.
```

---

## 5. Message templates

### Research note template
```text
[Source] URL or document name
[Finding] short factual statement
[Implication] what it means for our project
[Confidence] high / medium / low
```

### Decision template
```text
[Decision] ...
[Context] ...
[Options considered] ...
[Chosen option] ...
[Reason] ...
[Follow-up] ...
```

### Task template
```text
[Task ID] short-id
[Goal] one sentence
[Owner] person or bot
[Done when] explicit acceptance criterion
[Blockers] if any
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

## 6. Recommended setup order

### Step 1: Create the roles
- `Owner`
- `Architect`
- `Developer`
- `Observer`
- `Bot`

### Step 2: Create the minimal channels
- `#project-vision`
- `#decisions`
- `#research-notes`
- `#roadmap`
- `#task-queue`
- `#dev-log`
- `#runtime-summary`
- `#runtime-alerts`

### Step 3: Apply permissions
- Restrict posting in `#decisions`, `#runtime-summary`, and `#runtime-alerts`
- Keep research and task channels writable by the active contributors

### Step 4: Pin the templates
- Add the pinned messages above to the corresponding channels

### Step 5: Start using the contract
- All future research goes to `#research-notes`
- All final decisions go to `#decisions`
- All active work goes to `#task-queue`
- All runtime telemetry goes to the bot channels

---

## 7. Recommended operational rules

1. **Do not mix final decisions with discussion.**
2. **Do not put logs into research channels.**
3. **Do not post raw runtime noise into planning channels.**
4. **Keep each task small and explicit.**
5. **Use threads for elaboration if a topic grows large.**
6. **Prefer summaries in the top-level channel and detail in linked docs.**

---

## 8. What the bot should eventually post

The bot should eventually support these classes of output:

- periodic state snapshots
- deployment success/failure
- exceptions and stack traces
- CPU spikes or memory risk
- room-level threats
- resource bottlenecks
- milestone notifications

The bot should keep inline messages short and attach detailed diagnostics only when needed.

---

## 9. Current recommendation

If you want the lightest acceptable setup, create only:

- roles: `Owner`, `Architect`, `Developer`, `Observer`, `Bot`
- channels: the 8-channel minimal set above
- pinned templates in each channel

That is enough to start the project cleanly without over-engineering the Discord side.
