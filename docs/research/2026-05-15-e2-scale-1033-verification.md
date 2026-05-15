# E2 Scale Verification for Issue 1033

Date: 2026-05-15
Branch: `fix/e2-scale-1033`
Scope: Verify the E2 simulator multi-repetition scale path after the #1042/#1049 resource guard and failure-artifact changes.

## Summary

The safe verification sequence stopped before the requested >=5-environment run. The local resource guard rejected the 5-worker request on this host because it required 13036 MiB memory+swap while the host reported about 6871 MiB, Docker socket access was denied, and 5 bounded native-build jobs would oversubscribe the 4-CPU host. No unsafe 5-worker simulator command was launched after that guard rejection.

The guarded 2-variant x 2-repetition smoke was attempted as two separate 2-worker runs because the harness CLI deduplicates repeated variant IDs. Both smoke runs stopped at the required environment gate before Docker startup because `STEAM_KEY` was not present. The harness still wrote redacted run summaries, setup-failure artifacts, owned-room scorecards, resource-guard decisions, and exact-run cleanup evidence.

Durable ignored runtime artifact:

- `runtime-artifacts/rl-control-loop/e2-scale-1033-verification/verification_summary.json`

## Commands

Resource preflight was collected by importing `scripts/screeps_rl_simulator_harness.py` and calling `build_resource_guard_decision` for the 2-worker smoke and 5-worker scale requests.

Smoke commands:

```bash
timeout 180s python3 scripts/screeps_rl_simulator_harness.py run --run-id e2-scale-1033-smoke-a --out-dir runtime-artifacts/rl-simulator --variants construction-priority.incumbent.v1,construction-priority.container-prioritized-shadow.v1 --ticks 1 --workers 2 --room W3N9 --shard shardX --branch activeWorld --code-path prod/dist/main.js --map-source-file /root/screeps/maps/map-0b6758af.json
timeout 180s python3 scripts/screeps_rl_simulator_harness.py run --run-id e2-scale-1033-smoke-b --out-dir runtime-artifacts/rl-simulator --variants construction-priority.incumbent.v1,construction-priority.container-prioritized-shadow.v1 --ticks 1 --workers 2 --room W3N9 --shard shardX --branch activeWorld --code-path prod/dist/main.js --map-source-file /root/screeps/maps/map-0b6758af.json
```

Targeted regression tests:

```bash
PYTHONPATH=scripts python3 -m unittest scripts.test_screeps_rl_simulator_harness.RlSimulatorHarnessTest.test_resource_guard_rejects_workers_5_on_8gb_host_and_writes_deterministic_failure scripts.test_screeps_rl_simulator_harness.RlSimulatorHarnessTest.test_run_failure_artifacts_use_phase_specific_paths_and_types scripts.test_screeps_rl_simulator_harness.RlSimulatorHarnessTest.test_exact_run_cleanup_targets_only_matching_worker_containers
```

## Guard Decisions

| Request | Variants | Decision | Host available | Required | Docker | Result |
| --- | ---: | --- | ---: | ---: | --- | --- |
| 2 workers | 2 | allowed | about 6.8 GiB memory+swap | 6136 MiB | unavailable to this user | Smoke attempted, stopped at required-env |
| 5 workers | 5 | rejected | about 6.7 GiB memory+swap | 13036 MiB | permission denied | Scale verification not launched |

5-worker rejected reasons:

- `workers=5 effectiveWorkers=5 requires 13036 MiB memory/swap; host reports 6871 MiB`
- `active Docker stack check failed: permission denied while trying to connect to the docker API at unix:///var/run/docker.sock`
- Warning: `native build jobs=5 can oversubscribe cpuCount=4`

## Per-Environment Results

| Run ID | Variant | Success | Ticks | Error |
| --- | --- | --- | ---: | --- |
| `e2-scale-1033-smoke-a` | `construction-priority.incumbent.v1` | false | 0 | `STEAM_KEY environment variable is required for run mode` |
| `e2-scale-1033-smoke-a` | `construction-priority.container-prioritized-shadow.v1` | false | 0 | `STEAM_KEY environment variable is required for run mode` |
| `e2-scale-1033-smoke-b` | `construction-priority.incumbent.v1` | false | 0 | `STEAM_KEY environment variable is required for run mode` |
| `e2-scale-1033-smoke-b` | `construction-priority.container-prioritized-shadow.v1` | false | 0 | `STEAM_KEY environment variable is required for run mode` |

Smoke artifact paths:

- `runtime-artifacts/rl-simulator/e2-scale-1033-smoke-a/run_summary.json`
- `runtime-artifacts/rl-simulator/e2-scale-1033-smoke-a/setup_failure.json`
- `runtime-artifacts/rl-simulator/e2-scale-1033-smoke-a/owned_room_scorecard.json`
- `runtime-artifacts/rl-simulator/e2-scale-1033-smoke-b/run_summary.json`
- `runtime-artifacts/rl-simulator/e2-scale-1033-smoke-b/setup_failure.json`
- `runtime-artifacts/rl-simulator/e2-scale-1033-smoke-b/owned_room_scorecard.json`

## Result

Issue #1033 is not validated at scale on this host. Attempted smoke success was 0/4 environments because the host lacks the required private-server runtime secret, and the 5-environment verification was correctly blocked by the resource guard before launch.

No code bug was identified in the harness during this bounded verification. The actionable blocker is host preparation: rerun on a host with Docker access for the runner user, `STEAM_KEY` present in the environment, no active simulator/private-smoke stacks, and at least 13036 MiB memory+swap headroom. Then repeat the 2x2 smoke before launching the smallest guarded >=5-environment run.
