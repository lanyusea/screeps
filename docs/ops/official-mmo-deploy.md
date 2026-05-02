# Official Screeps MMO Deploy Runbook

Date: 2026-04-28

Issue: refs #33. Do not close #33 from a PR body until this path is merged, dispatched, and the live deploy plus post-deploy monitoring evidence are verified.

## Purpose

This runbook is the safe release path for the current official target:

- API: `https://screeps.com`
- Code branch: `main`
- World shard/room: `shardX/E26S49`
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

## Live Deploy

Load `SCREEPS_AUTH_TOKEN` into the environment through local secret storage or CI secrets. Do not print it.

```bash
mkdir -p runtime-artifacts/official-screeps-deploy

python3 scripts/screeps_official_deploy.py \
  --deploy \
  --activate-world \
  --confirm "deploy main to shardX/E26S49" \
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
- `confirmation`: required for deploy mode, exactly `deploy main to shardX/E26S49`.

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

After a successful live deploy, capture runtime evidence for `shardX/E26S49`:

```bash
python3 scripts/screeps-runtime-monitor.py summary --room shardX/E26S49
python3 scripts/screeps-runtime-monitor.py alert --room shardX/E26S49

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
