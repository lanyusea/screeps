# Official Screeps MMO Deploy Runbook

Date: 2026-04-28

Issue: refs #33. Do not close #33 from a PR body until this path is merged, dispatched, and the live deploy plus post-deploy monitoring evidence are verified.

## Purpose

This runbook is the safe release path for the current official target:

- API: `https://screeps.com`
- Code branch: `main`
- World shard/room: `shardX/E17S59`
- Artifact: `prod/dist/main.js`

The deploy path uploads only module `main`, verifies round-trip SHA-256 hashes, optionally sets `main` as `activeWorld`, and emits JSON evidence without auth tokens, request headers, local bundle contents, or remote module contents.

## Local Gate

Run from the repository root:

```bash
python3 -m unittest scripts/test_screeps_official_deploy.py

cd prod
npm run typecheck
npm test -- --runInBand
npm run build
cd ..

python3 scripts/screeps_official_deploy.py --dry-run --activate-world
```

The dry run does not read `SCREEPS_AUTH_TOKEN` and does not call the Screeps API. It checks that the artifact exists and prints planned request shapes plus artifact size/SHA-256.

## Elevated Deploy Gate for Economy / Spawn Changes

Refs: #605, #592 (postmortem section 7), #63.

When a PR merges changes to any of these paths or modules, the deploy **must** pass an elevated gate before the official MMO upload proceeds:

- `prod/src/economy/**`
- `prod/src/spawn/**`
- Energy distribution, storage, link, refill, or worker body scaling logic
- Any module whose main effect is economy throughput or spawn lifecycle

### Gate requirements

1. **Private-server smoke evidence**: Run `scripts/screeps-private-smoke.py run` (or the equivalent harness) for a bounded tick window (default ≥ 100 ticks). The smoke must show `owned_spawns >= 1` and `owned_creeps >= 1` at the end of the window. Archive the smoke evidence JSON under `runtime-artifacts/private-smoke/`.

2. **Emergency hold / owner decision**: When private-server smoke is unavailable (for example missing `STEAM_KEY`, Steam client offline, or screeps-launcher host unreachable), the deploy must be explicitly HELD. Update #63 Project `Blocked by` to `smoke unavailable; owner decision required`, post a decision request in Discord #decisions (1497586175580311654) @ the owner, and do not proceed until the owner provides an explicit override.

3. **Staged rollout for large economy rewrites** (≥200 lines changed across economy/spawn files): Deploy the change first, observe post-deploy health for at least one scheduler cycle (~20 minutes), and do not merge or deploy the next gameplay-affecting PR until the post-deploy health gate passes (`ok=true`, `owned_spawns >= 1`, `owned_creeps >= 1`, `alert=false`). If health degrades, follow the P0 room_dead / spawn-collapse escalation contract.

### Detection

The scheduler must check the diff of the merged PR before triggering deploy. Enforce the elevated gate when either:
1. Any changed file matches `prod/src/economy/**` or `prod/src/spawn/**`, or
2. The PR is labeled/declared as touching economy-throughput or spawn-lifecycle logic (energy distribution/storage/link/refill/worker scaling), even outside those paths.

A baseline path detector using the merge commit's first parent (the pre-merge base tip, which avoids the empty-diff problem when the merge commit is already on the target branch):

```bash
# Use merge-commit^ (first parent) to diff what the PR actually changed
git diff --name-only <merge-commit>^..<merge-commit> | grep -E '^prod/src/(economy|spawn)/'
```

If the baseline detector is empty, require explicit reviewer confirmation that condition (2) is false before proceeding. Non-zero output from the baseline detector means the elevated gate applies automatically.

### Example classification

PR #588 (`e87059d`) added 847 lines to `linkManager.ts` and modified `economyLoop.ts` — touchpoints that would trigger this elevated gate. Under this policy, that PR would have required private-smoke evidence or an explicit owner hold before official MMO deploy.

## Live Deploy

Load `SCREEPS_AUTH_TOKEN` into the environment through local secret storage or CI secrets. Do not print it.

```bash
mkdir -p runtime-artifacts/official-screeps-deploy

python3 scripts/screeps_official_deploy.py \
  --deploy \
  --activate-world \
  --confirm "deploy main to shardX/E17S59" \
  --evidence-path runtime-artifacts/official-screeps-deploy/official-screeps-deploy.json
```

The script:

1. Reads `SCREEPS_AUTH_TOKEN` from the environment only.
2. Lists code branches through `GET /api/user/branches`.
3. Clones the active World branch, or `default`, to `main` only if `main` is missing.
4. Uploads `prod/dist/main.js` to `POST /api/user/code` as module `main`.
5. Verifies `GET /api/user/code?branch=main` by SHA-256 and size only.
6. When `--activate-world` is set, calls `POST /api/user/set-active-branch`, verifies branch metadata, and verifies `GET /api/user/code?branch=$activeWorld` by SHA-256 and size only.

The command exits non-zero if the token is missing, the confirmation phrase is wrong, an API request fails, or local/remote hashes do not match.

## GitHub Actions

Workflow: `.github/workflows/official-screeps-deploy.yml`

Manual dispatch inputs:

- `mode`: `dry-run` by default; `deploy` performs writes.
- `environment`: `official-screeps`; configure this GitHub environment with required reviewers if desired.
- `activate_world`: sets `main` as `activeWorld` after upload.
- `confirmation`: required for deploy mode, exactly `deploy main to shardX/E17S59`.

Required secret:

```text
SCREEPS_AUTH_TOKEN
```

The workflow runs the Python deploy-helper tests, production typecheck, Jest, and build before any deploy write. It uploads the deploy evidence JSON as a workflow artifact.

If a controller cannot push the workflow file because its GitHub token lacks `workflow` scope, keep the script/docs/tests commit, state the workflow-scope blocker in the PR body and issue evidence, and have a controller with `workflow` scope add the workflow file.

## Evidence Contract

Deploy evidence JSON must include:

- local git commit SHA and dirty flag
- safe API URL, branch, shard, and room
- artifact path, byte size, and SHA-256
- request method/path/status summaries without auth headers
- branch creation/activeWorld metadata
- branch and activeWorld code verification status by SHA-256

Evidence JSON must not include:

- `SCREEPS_AUTH_TOKEN`
- `Authorization`, `X-Token`, or other auth headers
- `prod/dist/main.js` contents
- remote module contents

## Post-Deploy Monitoring

After a successful live deploy, capture runtime evidence for `shardX/E17S59`:

```bash
python3 scripts/screeps-runtime-monitor.py summary --room shardX/E17S59
python3 scripts/screeps-runtime-monitor.py alert --room shardX/E17S59

python3 scripts/screeps_runtime_summary_console_capture.py \
  --live-official-console \
  --console-channel console \
  --console-channel console:shardX
```

Attach or reference:

- deploy evidence JSON path or workflow artifact
- runtime summary/alert JSON and any generated room images
- runtime-summary console capture artifact, or a clear telemetry-silence finding
- deployed git commit SHA

Escalate through `docs/ops/runtime-room-monitor.md` if alerts show hostiles, damage, spawn collapse, downgrade risk, telemetry silence, or loop exceptions.
