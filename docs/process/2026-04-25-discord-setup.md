# Discord Setup Process Journal

Date: 2026-04-25

## Why this matters

We are using Discord as the coordination layer for the Screeps project, so the server structure itself becomes part of the project infrastructure.

## What we did

1. Defined a minimal role model.
   - Kept only `Owner` and `Bot` as the default roles.
   - Chose to avoid over-design because only two people will participate.

2. Created the core channel structure.
   - `#project-vision`
   - `#decisions`
   - `#research-notes`
   - `#roadmap`
   - `#task-queue`
   - `#dev-log`
   - `#runtime-summary`
   - `#runtime-alerts`

3. Established channel-specific message contracts.
   - Each channel now has a clear purpose.
   - Pinned messages define what belongs where.

4. Turned the Discord structure into a canonical project spec.
   - Added `docs/discord-project-spec.md`.
   - Added `docs/discord-server-setup-guide.md`.

## What we verified

- The channel layout supports the full workflow:
  research -> decision -> task -> development -> runtime feedback
- The structure is simple enough for a two-person project.
- The setup can be used as a repeatable template for future work.

## Blog-worthy takeaways

- A Discord server can function as a lightweight project operating system.
- Small teams benefit from fewer roles and clearer channels rather than complex governance.
- Separating research, decisions, tasks, and runtime feedback makes later writing and review much easier.

## Follow-up ideas for a blog post

- How to turn Discord into a project control plane
- Why minimal roles beat elaborate permissions in a two-person AI project
- How structured channels improve traceability and writing quality
