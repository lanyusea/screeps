# Screeps Bot Production Source

This folder contains runnable production code for the Screeps: World bot.

## Current status

MVP economy-loop base is now implemented:

- TypeScript source
- Jest tests
- memory initialization
- dead creep memory cleanup
- small kernel tick loop
- Screeps-compatible exported `loop`
- colony detection
- worker body builder
- worker spawn planning
- worker role counting
- worker harvest / transfer / build / upgrade task selection
- worker task transition logic
- bundled build output at `dist/main.js`

Not implemented yet:

- deployment credentials
- MMO upload
- private server config
- deterministic private-server smoke test
- advanced spawn queue priorities
- multi-room logic
- remote mining
- combat / defense logic

## Setup

```bash
cd prod
npm install
```

## Verify

```bash
npm run typecheck
npm test
npm run build
```

Expected build artifact:

```text
prod/dist/main.js
```

## Secrets policy

Do not commit Screeps auth tokens or private server credentials.
Future deployment config should use local ignored files or environment variables.
