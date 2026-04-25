# Screeps Bot Production Source

This folder contains runnable production code for the Screeps: World bot.

## Current status

MVP skeleton only:

- TypeScript source
- Jest tests
- memory initialization
- dead creep memory cleanup
- small kernel tick loop
- Screeps-compatible exported `loop`
- bundled build output at `dist/main.js`

Not implemented yet:

- deployment credentials
- MMO upload
- private server config
- spawn planning
- creep roles/tasks
- room economy logic

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
