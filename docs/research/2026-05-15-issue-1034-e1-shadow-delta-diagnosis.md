# Issue 1034 E1 Shadow Delta Diagnosis

Date: 2026-05-15

## Question

Issue #1034 asked whether the E1 shadow eval `changedTopCount` decline from 134 -> 42 -> 14 was benign policy convergence or dangerous data/evaluator coverage collapse.

## Evidence

The local worktree does not contain `runtime-artifacts/`, so the inspected artifacts were read from `/root/screeps/runtime-artifacts/`.

| Artifact | Generated | Dataset | Samples and coverage | Room sample distribution | Ranking diffs | Changed top | Family split |
| --- | --- | --- | --- | --- | ---: | ---: | --- |
| `rl-gate-ff93c4694f08-shadow` | 2026-05-13T10:53:55Z | `rl-60b314addef5` | 200 samples, 191 accepted, 2,331 source artifacts, 2,434 runtime summaries | E26S49=122, E27S49=28, E26S48=25, E27S48=24, E24S49=1 | 451 | 134 | construction 280/121, expansion 171/13 |
| `rl-gate-5a1fa785798d-shadow` | 2026-05-13T22:08:26Z | `rl-d1b56cbc4603` | 200 samples, 198 accepted, 2,463 source artifacts, 5,146 runtime summaries | E26S49=193, E27S49=5, E24S49=2 | 410 | 42 | construction 212/42, expansion 198/0 |
| `rl-gate-93bf1aa18b62-shadow` | 2026-05-14T04:22:20Z | `rl-ebf33fae619f` | 200 samples, 198 accepted, 2,538 source artifacts, 5,328 runtime summaries | E26S49=193, E27S49=5, E24S49=2 | 406 | 14 | construction 208/14, expansion 198/0 |
| `strategy-shadow-20260514T161345Z` | 2026-05-14T16:13:45Z | `rl-b6a57148129f` | 300 evaluated artifacts, paired gate had 200 samples and 191 accepted | E26S49=122, E27S49=28, E26S48=25, E27S48=24, E24S49=1 | 555 | 192 | construction 384/179, expansion 171/13 |
| `gate-20260514T222356Z-shadow` | 2026-05-14T22:25:57Z | `rl-5db4d84c8ede` | 151 evaluated artifacts, paired gate had 200 samples and 198 accepted, home room W3N9 | E26S49=193, E27S49=5, E24S49=2 in dataset; shadow source came from official deploy summaries | 0 | 0 | construction 0/0, expansion 0/0 |

Family split values are `rankingDiffCount/changedTopCount`.

## Diagnosis

The 134 -> 42 -> 14 drop is not benign policy convergence. `rankingDiffCount` stayed high at 451 -> 410 -> 406, both model families were still emitted, and the decline was concentrated in construction-priority `changedTopCount`. A converged policy would normally reduce both top-choice changes and broader ranking movement. Here, broader ranking movement persisted.

The stronger explanation is data coverage/sample composition drift. The 134-count baseline used a 5-room sample mix. The 42-count and 14-count gates collapsed to an E26S49-heavy 3-room mix and dropped E26S48/E27S48 coverage. That removed much of the context where the construction shadow model flips the top recommendation.

The 2026-05-14T16:13:45Z rebound to `changedTopCount=192` and `rankingDiffCount=555` confirms the evaluator had not prematurely converged to no signal. When fed broader coverage again, the shadow evaluator produced record movement.

The later W3N9 report `gate-20260514T222356Z-shadow` is a separate low-signal anomaly. It parsed 151 artifacts from official deploy summary paths and produced 2 model reports but 0 ranking diffs and 0 changed-top events. Those artifacts did not expose construction-priority or territory-recommendation ranking contexts, so the old report shape could be misread as policy convergence. This branch adds `rankingContextCount` plus a warning for parsed artifacts that contain no evaluable contexts for a model family.

## Conclusion Classification

Classification: coverage/sampling collapse plus missing ranking-context instrumentation, not policy convergence.

`rlc-20260513-changedTopCount-drop-signal` should not be closed yet. The controller should mirror the intended registry transition as:

- Status: `ACTIONED` after this instrumentation patch lands.
- Category: `data-traversal` / `shadow-eval-instrumentation`.
- Required evidence to close: two consecutive E1 gates with nonzero `rankingContextCount` for both strategy families, no no-context warnings, explicit room/source coverage in the gate evidence, and no repeated 0/low `changedTopCount` unless `rankingDiffCount` also falls and the room mix remains stable.
- Next verification: the next E1 shadow-eval gate after this commit should include `rankingContextCount` in the strategy-shadow report and generation summary.

No repository-tracked `conclusion-registry.json` exists in this worktree. The live registry is under `/root/screeps/runtime-artifacts/rl-control-loop/conclusion-registry.json`, so it was not edited here.
