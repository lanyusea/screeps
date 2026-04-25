# Gemini Code Assist Review Style Guide

Only comment on **CRITICAL** issues for this repository.

A critical issue is one that is likely to cause at least one of:

- Screeps runtime crash or halted exported `loop` execution.
- Colony unrecoverability, including spawn/economy deadlocks or worker recovery failure.
- Broken build, typecheck, test, bundling, upload, or official/private-server deployment path.
- Secret leakage or unsafe handling of Screeps auth tokens, Steam keys, private-server credentials, or API responses.
- Destructive or wrong-target operations involving branch `main`, shard `shardX`, room `E48S28`, or spawn placement.
- Runtime monitoring false negatives/false positives that could hide hostiles, damage, or bot failure, or spam alert channels.
- Memory schema/task-state incompatibility that breaks existing Screeps `Memory` or creep behavior.

Do not comment on style, naming, formatting, minor refactors, docs wording, small performance ideas, or speculative architecture unless the issue directly creates a critical risk above.

If no critical issue is present, avoid inline comments.

When a critical comment is necessary, keep it short and actionable:

```text
[critical] <impact in one sentence>
Fix: <minimal correction>
```

Repository context:

- Production Screeps code lives under `prod/`.
- Durable docs live under `docs/`.
- Generated Screeps bundle is `prod/dist/main.js`; it should be produced by `npm run build`, not hand-edited.
- Expected verification from `prod/`: `npm run typecheck`, `npm test -- --runInBand`, `npm run build`.
- AI/agent project instructions live in root `AGENTS.md`; singular `AGENT.md` is only a pointer.
