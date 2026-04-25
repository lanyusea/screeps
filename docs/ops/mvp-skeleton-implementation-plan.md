# Screeps MVP Skeleton Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task. Follow strict TDD for production behavior.

**Goal:** Create the first `prod/` TypeScript Screeps bot skeleton with build, tests, memory initialization, and a minimal tick loop architecture.

**Architecture:** Start with a small kernel + memory module. Build outputs to `prod/dist/main.js`, which exports Screeps `loop`. Tests run against TypeScript source and verify behavior before production code is added.

**Tech Stack:** TypeScript, Jest, ts-jest, `@types/screeps`, Rollup or esbuild-compatible bundle path. Initial skeleton should not require running a private server.

---

## Task 1: Create npm/TypeScript/Jest skeleton

**Objective:** Create the basic `prod/` project structure and test runner.

**Files:**
- Create: `prod/package.json`
- Create: `prod/tsconfig.json`
- Create: `prod/jest.config.cjs`
- Create: `prod/src/`
- Create: `prod/test/`

**Steps:**

1. Create `package.json` with scripts:
   - `typecheck`
   - `test`
   - `build`
2. Add dev dependencies:
   - `typescript`
   - `jest`
   - `ts-jest`
   - `@types/jest`
   - `@types/screeps`
3. Configure TypeScript for CommonJS-compatible Screeps output.
4. Configure Jest to run TypeScript tests.
5. Run `npm install` in `prod/`.
6. Run `npm run typecheck` and `npm test`; initial tests may be empty but tooling must execute.

**Verification:**

```bash
cd prod
npm run typecheck
npm test
```

Expected: commands complete without configuration errors.

---

## Task 2: Add memory initialization with TDD

**Objective:** Define a minimal versioned memory schema and initializer.

**Files:**
- Create: `prod/test/memory.test.ts`
- Create: `prod/src/memory/schema.ts`

**RED:** Write tests first:

- initializes `Memory.meta.version` if missing
- preserves existing memory values
- creates `Memory.creeps` if missing

**Expected first run:** fails because `initializeMemory` does not exist.

**GREEN:** Implement minimal `initializeMemory()`.

**Verification:**

```bash
cd prod
npm test -- memory.test.ts
npm run typecheck
```

---

## Task 3: Add dead creep cleanup with TDD

**Objective:** Remove memory for creeps no longer present in `Game.creeps`.

**Files:**
- Modify: `prod/test/memory.test.ts`
- Modify: `prod/src/memory/schema.ts`

**RED:** Add test:

- given `Memory.creeps.dead = {}` and `Game.creeps` without `dead`, cleanup removes `Memory.creeps.dead`
- keeps entries that still exist in `Game.creeps`

**GREEN:** Implement `cleanupDeadCreepMemory()`.

**Verification:**

```bash
cd prod
npm test -- memory.test.ts
npm run typecheck
```

---

## Task 4: Add kernel tick loop with TDD

**Objective:** Create a small kernel that orders startup, memory init, cleanup, and telemetry.

**Files:**
- Create: `prod/test/kernel.test.ts`
- Create: `prod/src/kernel/Kernel.ts`

**RED:** Write tests for:

- kernel calls memory initialization once per tick
- kernel calls dead creep cleanup once per tick
- kernel does not throw when no rooms/spawns exist

**GREEN:** Implement minimal `Kernel.run()`.

**Verification:**

```bash
cd prod
npm test -- kernel.test.ts
npm run typecheck
```

---

## Task 5: Add Screeps entrypoint

**Objective:** Export Screeps-compatible `loop` from `src/main.ts` and connect it to the kernel.

**Files:**
- Create: `prod/src/main.ts`
- Create: `prod/test/main.test.ts`

**RED:** Test that `loop` is exported and callable.

**GREEN:** Implement `export const loop = () => kernel.run()`.

**Verification:**

```bash
cd prod
npm test -- main.test.ts
npm run typecheck
```

---

## Task 6: Add build output

**Objective:** Ensure `npm run build` produces `prod/dist/main.js`.

**Files:**
- Create or modify bundler config, likely `prod/rollup.config.mjs` or use `tsc` initially.
- Modify: `prod/package.json`

**Steps:**

1. Prefer simplest reliable build first.
2. Build should emit a deployable CommonJS-style `main.js`.
3. Avoid actual Screeps upload in MVP skeleton.

**Verification:**

```bash
cd prod
npm run build
test -f dist/main.js
```

Expected: `dist/main.js` exists and contains an exported `loop`.

---

## Task 7: Document MVP skeleton usage

**Objective:** Document how to run checks and what is not implemented yet.

**Files:**
- Create: `prod/README.md`
- Update: `docs/README.md` if needed
- Update: `docs/process/active-work-state.md`

**Verification:**

Documentation must include:

- install command
- typecheck command
- test command
- build command
- explicit statement that deploy credentials are not configured yet

---

## Acceptance criteria

The MVP skeleton is complete when:

```bash
cd prod
npm install
npm run typecheck
npm test
npm run build
```

all pass, and `prod/dist/main.js` exists.

## Non-goals for this skeleton

- No actual MMO upload yet.
- No private server config yet.
- No creep role implementation yet.
- No spawn planner yet.
- No Overmind-style full hierarchy yet.
