# Discord Server Configuration Plan

> For Hermes: use this Discord channel design as the operating contract for all future Screeps work.

**Goal:** establish a clean Discord structure for research, decisions, implementation, and runtime monitoring before continuing the Screeps project.

**Architecture:** a small set of top-level channels will separate governance, research, planning, implementation, and runtime signals. Bot output will be structured and routed into dedicated summary/alert channels. This keeps future work traceable and reduces noise.

**Tech Stack:** Discord channels/roles, pinned message templates, structured status posts, future bot-generated summaries and alerts.

---

### Task 1: Freeze the minimal channel set

**Objective:** define the first production-ready channel layout.

**Channels:**
- `#project-vision`
- `#decisions`
- `#research-notes`
- `#roadmap`
- `#task-queue`
- `#dev-log`
- `#runtime-summary`
- `#runtime-alerts`

**Verification:** all future work is posted into one of these channels or a thread under them.

### Task 2: Define roles and permissions

**Objective:** make posting responsibilities explicit.

**Roles:** `Owner`, `Architect`, `Developer`, `Observer`, `Bot`.

**Verification:** only Bot posts to runtime channels; decisions are controlled; task queue is writable by working contributors.

### Task 3: Standardize message templates

**Objective:** ensure every post is scannable and consistent.

**Templates:** research note, decision, task, runtime summary, runtime alert.

**Verification:** future bot output and human posts follow these templates.

### Task 4: Pin the operating rules

**Objective:** create a short “where to post what” reference for contributors.

**Verification:** new contributors can infer the correct channel without asking.

### Task 5: Use this layout as the dependency for all future work

**Objective:** ensure every next research or implementation item references the Discord layout.

**Verification:** future docs and task breakdowns cite the channel map and message conventions.
