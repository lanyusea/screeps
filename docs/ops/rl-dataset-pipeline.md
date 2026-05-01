# RL Dataset Collection And Storage Pipeline

Status: first bounded implementation slice for issue #415.

## Safety Rule

Learned-policy outputs are offline, shadow-only, or high-level recommendation inputs until all of these gates pass:

- simulator evidence;
- historical MMO validation;
- KPI rollout gates;
- rollback gates.

No dataset, model, replay, or shadow report may directly write official MMO creep intents, spawn intents, construction intents, market orders, memory mutations, or RawMemory commands. The first allowed output surface is an offline high-level recommendation label such as construction priority, remote target, expansion candidate, defense posture, or bounded weight vector, and even that must pass deterministic validators before later live use.

## Exporter

Use the stdlib-only exporter:

```bash
python3 scripts/screeps_rl_dataset_export.py --out-dir runtime-artifacts/rl-datasets
```

With no positional paths it scans these local roots, tolerating missing directories:

- `/root/screeps/runtime-artifacts`
- `/root/.hermes/cron/output`
- `runtime-artifacts`

The exporter does not call live APIs, does not require Screeps or Steam credentials, skips binary and oversized files, and never copies raw artifact contents into the dataset. It consumes:

- exact-prefix runtime-summary console artifacts;
- JSON runtime-summary artifacts;
- JSON runtime monitor summary payloads when present.
- JSON strategy-shadow replay reports when present, as metadata only.

The output location is gitignored by the repository-level `runtime-artifacts/` ignore rule.

## Strategy-Shadow Report Generation

Generate bounded offline strategy-shadow reports from saved local runtime artifacts:

```bash
python3 scripts/screeps_strategy_shadow_report.py --out-dir runtime-artifacts/strategy-shadow
```

With no positional paths, the generator scans the same safe local roots as the dataset exporter: `/root/screeps/runtime-artifacts`, `/root/.hermes/cron/output`, and repo-local `runtime-artifacts`. The command wraps `evaluateStrategyShadowReplay` through the built `prod/dist/main.js` export, so run `npm --prefix prod run build` first if the production bundle is missing or stale. That build form preserves the repo-root cwd for the following Python command and its default paths.

Reports are written under the gitignored `runtime-artifacts/strategy-shadow/` path. Each report records source path/hash metadata, evaluated artifact count, model families, candidate/incumbent strategy IDs, ranking-diff and changed-top counts, KPI summary fields, generated time, bot commit, and bounded sanitized warnings. Ranking diff bodies are sampled and bounded; raw runtime-summary lines, raw logs, and configured secret values are not copied.

Safety contract: the generator only reads saved local artifacts and the local built bundle. It makes no live API calls, performs no official MMO writes, writes no `Memory` or `RawMemory`, and emits `liveEffect: false` plus explicit safety metadata in every report. Generated reports are suitable as offline dataset and historical validation input only.

## Storage Layout

Each run writes one deterministic directory:

```text
runtime-artifacts/rl-datasets/<run-id>/
  scenario_manifest.json
  run_manifest.json
  source_index.json
  ticks.ndjson
  kpi_windows.json
  episodes.json
  dataset_card.md
```

The default run ID is a content hash over bot commit, source artifact hashes, parsed runtime records, sample IDs, split settings, and sample limit. Re-running the exporter on the same inputs produces the same run ID and file contents. A cron job may pass `--run-id` when it needs an externally assigned ID.

## File Contracts

### `scenario_manifest.json`

The first slice uses a historical local artifact replay scenario, not a resettable simulator scenario.

Required fields:

- `type`: `screeps-rl-historical-artifact-replay`
- `schemaVersion`
- `scenarioId`
- `runId`
- `sourceMode`
- `resettableSimulator`: `false`
- `liveSecretsRequired`: `false`
- `networkRequired`: `false`
- `officialMmoWritesAllowed`: `false`
- `botCommit`
- `sourceArtifactIds`

Future simulator runs should extend the same slot with seed, package versions, scenario fixture IDs, bot bundle, memory fixture, strategy registry version, and deterministic reset metadata.

### `run_manifest.json`

The run manifest is the primary dataset index.

Required fields:

- `type`: `screeps-rl-dataset-run`
- `schemaVersion`
- `runId`
- `botCommit`
- `source.inputPaths`
- `source.scannedFiles`
- `source.sourceArtifactCount`
- `source.matchedArtifactCount`
- `source.strategyShadowReportCount`
- `source.skippedFileCount`
- `strategy.registryPath`
- `strategy.decisionSurfacesObserved`
- `strategy.metadataAvailability`
- `strategy.shadowReports`
- `strategy.liveEffect`: `false`
- `split.method`
- `split.seed`
- `split.evalRatio`
- `split.counts`
- `sampleCount`
- `storage.layout`
- `storage.files`
- `safety`
- `retention`

Strategy registry metadata is included when artifacts expose decision fields. Current high-level fields are:

- `constructionPriority.nextPrimary` -> `construction-priority`
- `territoryRecommendation.next` -> `expansion-remote-candidate`

The exporter records the registry path (`prod/src/strategy/strategyRegistry.ts`) and the observed decision surfaces. It does not parse or execute strategy code.

When a saved strategy-shadow replay report is present, the exporter records bounded metadata only: source ID, redacted path, line number, enabled flag, artifact count, model report count, ranking-diff count, model families, incumbent IDs, and candidate IDs. It does not copy raw report warnings or inline ranking bodies into the dataset.

### `source_index.json`

Source metadata is kept separate from samples.

Required fields:

- source ID;
- redacted display path;
- byte size;
- SHA-256;
- strategy-shadow report metadata when present;
- skipped file reason and bounds, when applicable.

Raw artifact text is not copied. This keeps runtime summaries, monitor stdout, and cron output from accidentally persisting credentials or unrelated operator context inside the dataset.

### `ticks.ndjson`

One JSON object per room/tick sample.

Required fields:

- `type`: `screeps-rl-tick-sample`
- `schemaVersion`
- `sampleId`
- `botCommit`
- `source`
- `observation`
- `actionLabels`
- `reward`
- `split`
- `safety`

Observation fields are selected, structured summaries:

- tick, room, shard;
- energy availability/capacity;
- worker count and task counts;
- spawn idle/spawning counts;
- controller numeric fields;
- resource numeric fields and events;
- combat numeric fields and events;
- CPU and reliability numeric fields;
- monitor-only summary counters when the source is a runtime monitor summary.

Action-label fields are high-level recommendation labels only:

- decision surface;
- source decision field;
- registry family;
- label or target room;
- score/confidence-like numeric fields when present;
- expected KPI movement, preconditions, and risks when present;
- `liveEffect: false`.

Reward fields are component labels only in this slice:

- `status`: `components-only`
- `scalarReward`: `null`
- lexicographic order: reliability, territory, resources, kills;
- reliability components such as loop exceptions, telemetry silence, and CPU bucket;
- territory components such as owned-room observation, controller level/progress, and downgrade ticks;
- resource components such as stored, carried, dropped, harvested, and transferred energy;
- kill/combat components such as hostile counts, attack damage, destroyed objects, and destroyed creeps.

Scalar rewards must not be introduced until the experiment data card defines how the scalar respects the project vision order: territory first, resources second, enemy kills third, all behind a reliability floor.

### `kpi_windows.json`

This is the existing `scripts/screeps_runtime_kpi_reducer.py` output over the exported runtime-summary window. It provides territory/resource/combat window evidence for joins and for later historical validation.

### `episodes.json`

The first slice writes one historical-window episode summary.

Required fields:

- `episodeId`
- `runId`
- sample count;
- room list;
- first/latest tick;
- KPI window status;
- safety gates and required evidence before any live influence.

Future simulator episodes should add scenario seed, reset ID, worker ID, pass/fail gates, validator decisions, rollback result, and wall-clock throughput.

### `dataset_card.md`

The generated card summarizes source counts, rooms, splits, observed strategy surfaces, redaction, retention, and safety gates. Future experiments should start from `docs/ops/rl-data-card-template.md`.

## Train/Eval Split

The first slice assigns splits deterministically per `sampleId`:

- method: `sha256-threshold`
- default seed: `screeps-rl-v1`
- default eval ratio: `0.2`

This avoids wall-clock or file-order drift. A run should not change split seed or ratio after training starts; create a new run ID instead.

## Retention And Redaction

Generated datasets remain local derived artifacts by default.

Rules:

- Do not commit `runtime-artifacts/rl-datasets/` without explicit review.
- Do not copy raw source artifact contents into dataset files.
- Do not persist Screeps auth tokens, Steam keys, private-server passwords, auth headers, or local secret paths.
- Record source hashes and redacted display paths instead of raw contents.
- If a configured secret environment value appears in an output file, the exporter fails.
- When a source artifact is unsafe or irrelevant, prefer skipping it and recording a skipped-file reason.

## Cron-Friendly Behavior

The exporter is deterministic and idempotent for the same inputs. It writes files atomically inside the run directory and emits only a compact JSON summary with counts, run ID, output directory, split counts, and file names. It does not print raw runtime-summary lines or artifact bodies.

## Follow-Up Slices

- Add simulator scenario manifests when issue #414 provides reset/step/observe artifacts.
- Add historical MMO replay validation joins for issue #417.
- Add validator accept/reject labels and rollback outcomes for issue #418.
- Add compressed columnar exports only after the JSON/NDJSON schema proves stable.
