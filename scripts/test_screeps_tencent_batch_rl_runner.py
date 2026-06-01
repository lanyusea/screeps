#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import copy
import io
import json
import os
import re
import shlex
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from typing import Callable
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import screeps_tencent_batch_rl_runner as runner
import screeps_rl_experiment_card as card_helper


CONTROLLER_IP = "43.128.104.34/32"
CONTROLLER_IP_HOST = "43.128.104.34"
READY_RUNTIME_SCORECARD_PATH = (
    "runtime-artifacts/rl-training/candidate-scorecards/run-test/rl-scorecard-run-test.json"
)


def legacy_multi_tier_scenario_id() -> str:
    legacy_ids = tuple(
        scenario_id
        for scenario_id in runner.MULTI_TIER_SCENARIO_IDS
        if scenario_id != runner.MULTI_TIER_SCENARIO_ID
    )
    if len(legacy_ids) != 1:
        raise AssertionError("expected exactly one legacy multi-tier scenario ID")
    return legacy_ids[0]


def ready_runtime_pair_scorecard_path(scorecard_id: str, candidate_id: str, baseline_id: str) -> str:
    return (
        "runtime-artifacts/rl-training/candidate-scorecards/run-test/"
        f"{candidate_id}--vs--{baseline_id}/{scorecard_id}.json"
    )


def add_file(tar: tarfile.TarFile, name: str, content: bytes = b"ok") -> None:
    info = tarfile.TarInfo(name)
    info.size = len(content)
    tar.addfile(info, io.BytesIO(content))


def add_special(tar: tarfile.TarFile, name: str, member_type: bytes, linkname: str = "") -> None:
    info = tarfile.TarInfo(name)
    info.type = member_type
    info.linkname = linkname
    tar.addfile(info)


def write_tar(path: Path, callback: Callable[[tarfile.TarFile], None]) -> None:
    with tarfile.open(path, "w:gz") as tar:
        callback(tar)


def controller_args() -> argparse.Namespace:
    return argparse.Namespace(
        asg_id="asg-test",
        billing_guard="/bin/billing-guard",
        bootstrap_timeout_seconds=1,
        controller_ip=CONTROLLER_IP,
        dataset_run_id="dataset-test",
        host_port_start=24125,
        preflight_only=False,
        region="ap-singapore",
        remote_base="/opt/screeps-batch/jobs",
        repetitions=1,
        scale_down_timeout_seconds=1,
        scale_environments=None,
        scale_timeout_seconds=1,
        secret_env="/tmp/secret.env",
        security_group_id="sg-test",
        scenario_id=runner.DEFAULT_SCENARIO_ID,
        require_multi_tier_scenario=False,
        known_hosts_path="/tmp/known_hosts",
        ssh_key="/tmp/id_ed25519",
        tccli="/bin/tccli",
        ticks=1,
        training_approach="bandit",
        training_timeout_seconds=1,
        transfer_timeout_seconds=1,
        allow_paid_failure_recurrence_validation=None,
        variant=None,
        worker_user="screeps-batch",
        workers=1,
    )


def run_git(args: list[str], cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def write_text(path: Path, text: str = "ok\n") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def write_ready_runtime_scorecard_artifact(root: Path) -> None:
    write_text(root / "remote" / READY_RUNTIME_SCORECARD_PATH, "{}\n")


def write_candidate_scorecard_set_artifacts(root: Path, scorecard_set: object) -> None:
    if not isinstance(scorecard_set, dict):
        return
    comparisons = scorecard_set.get("comparisons")
    if not isinstance(comparisons, list):
        return
    for comparison in comparisons:
        if not isinstance(comparison, dict):
            continue
        artifact_path = comparison.get("scorecardArtifactPath")
        if isinstance(artifact_path, str):
            write_text(root / "remote" / artifact_path, "{}\n")


def runtime_consumed_promotion_gate() -> dict[str, object]:
    return {
        "type": "screeps-rl-policy-update-promotion-gate",
        "schemaVersion": 1,
        "status": "runtime_consumed_shadow_candidate",
        "consumptionMode": "runtime_consumed",
        "policyUpdateGenerated": True,
        "runtimeParameterInjection": True,
        "runtimeParameterConsumption": True,
        "runtimeParameterConsumptionStatus": "consumed",
        "candidateParameterScope": "runtime_injected",
        "runtimeConsumedPromotionEligible": True,
        "loopAPromotionEligible": True,
        "loopBPromotionEligible": True,
        "missingPrerequisites": [],
        "reason": "tick-time runtime policy parameter consumption proof is present",
        "validationText": (
            "#924 scorecards and #907 change-control require tick-time runtime parameter "
            "consumption proof before Loop A or Loop B can treat a policy update as "
            "runtime-consumed or promotional."
        ),
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
    }


def non_consumed_promotion_gate() -> dict[str, object]:
    gate = runtime_consumed_promotion_gate()
    gate.update(
        {
            "status": "blocked_runtime_parameter_consumption_missing",
            "consumptionMode": "runtime_injected_scorecard_metadata_non_promotional",
            "runtimeParameterInjection": False,
            "runtimeParameterConsumption": False,
            "runtimeParameterConsumptionStatus": "missing_runtime_parameter_consumption",
            "runtimeConsumedPromotionEligible": False,
            "loopAPromotionEligible": False,
            "loopBPromotionEligible": False,
            "missingPrerequisites": ["runtime_parameter_consumption"],
            "reason": "scorecard metadata update is non-promotional without runtime consumption proof",
        }
    )
    return gate


def high_variance_consumed_promotion_gate() -> dict[str, object]:
    gate = runtime_consumed_promotion_gate()
    gate.update(
        {
            "status": "blocked_gradient_stability_untrusted",
            "runtimeConsumedPromotionEligible": False,
            "loopAPromotionEligible": False,
            "loopBPromotionEligible": False,
            "missingPrerequisites": ["gradient_stability"],
            "gradientStable": False,
            "trustedGradientUpdate": False,
            "highVariance": True,
            "reason": "runtime consumption proof is present but gradient stability is untrusted",
            "gradientStability": {
                "type": "screeps-rl-gradient-stability-gate",
                "schemaVersion": 1,
                "status": "untrusted",
                "classification": "insufficient_sample_high_variance",
                "trueGradient": True,
                "gradientStable": False,
                "trustedUpdate": False,
                "trustedGradientUpdate": False,
                "highVariance": True,
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            },
        }
    )
    return gate


def ready_runtime_parameter_injection() -> dict[str, object]:
    return {
        "status": "injected",
        "runtimeParameterInjection": True,
        "runtimeParameterConsumption": True,
        "runtimeParameterConsumptionStatus": "consumed",
        "policyUpdateEligible": True,
        "candidateParameterScope": "runtime_injected",
        "injectedVariantCount": 1,
        "consumedVariantCount": 1,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
    }


def missing_consumption_runtime_parameter_injection() -> dict[str, object]:
    return {
        "status": "injected",
        "runtimeParameterInjection": True,
        "runtimeParameterConsumption": False,
        "runtimeParameterConsumptionStatus": "missing_runtime_parameter_consumption",
        "policyUpdateEligible": False,
        "candidateParameterScope": "runtime_injected",
        "injectedVariantCount": 1,
        "consumedVariantCount": 0,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
    }


def write_policy_update_artifact(
    root: Path,
    artifact_path: str,
    parameters: object,
    promotion_gate: object | None = None,
) -> None:
    payload = {
        "parameters": parameters,
        "promotionGate": runtime_consumed_promotion_gate() if promotion_gate is None else promotion_gate,
    }
    write_text(root / "remote" / artifact_path, json.dumps(payload, sort_keys=True) + "\n")


def positive_policy_update(artifact_path: str) -> dict[str, object]:
    updated_parameters = {
        "baseScoreWeight": 1,
        "territorySignalWeight": 7,
        "resourceSignalWeight": 4,
        "killSignalWeight": 6,
        "riskPenalty": 4,
    }
    promotion_gate = runtime_consumed_promotion_gate()
    return {
        "iterations": 1,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "artifactPath": artifact_path,
        "updatedParameters": updated_parameters,
        "parameterDelta": {
            "baseScoreWeight": 0,
            "territorySignalWeight": 1,
            "resourceSignalWeight": 0,
            "killSignalWeight": 0,
            "riskPenalty": 0,
        },
        "promotionGate": copy.deepcopy(promotion_gate),
        "nextCandidatePolicy": {
            "parameters": copy.deepcopy(updated_parameters),
            "promotionGate": copy.deepcopy(promotion_gate),
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        },
    }


def decode_remote_bash_lc(remote_command: str) -> str:
    tokens = shlex.split(remote_command)
    script_arg = tokens[tokens.index("-lc") + 1]
    script_tokens = shlex.split(script_arg)
    return base64.b64decode(script_tokens[2]).decode("utf-8")


def generated_experiment_card() -> dict[str, object]:
    return {
        "card_id": "rl-exp-dataset-test-000000000000",
        "dataset_run_id": "dataset-test",
        "code_commit": "0" * 40,
        "created_at": "2026-05-17T00:00:00Z",
        "status": "shadow",
        "training_approach": "bandit",
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
            "ood_rejection": True,
            "conservative_actions_only": True,
        },
        "reward_model": {
            "type": "lexicographic",
            "component_order": ["reliability", "territory", "resources", "kills"],
            "component_weights": {
                "alpha_reliability": 1000000000,
                "beta_territory": 1000000,
                "gamma_resources": 1000,
                "delta_kills": 1,
            },
            "scalar_weighted_sum_authorized": False,
        },
        "simulation": {
            "ticks": 50,
            "workers": 1,
            "repetitions": 1,
            "room": "E1S1",
            "shard": "shardX",
            "branch": "$activeWorld",
            "code_path": "prod/dist/main.js",
            "map_source_file": "maps/map-0b6758af.json",
            "simulator_out_dir": "runtime-artifacts/rl-simulator",
        },
        "scenario": {
            "type": "screeps-rl-training-scenario",
            "scenario_id": runner.DEFAULT_SCENARIO_ID,
            "scenario_tier": "single_room_smoke",
            "label": "E1S1 single-room no-hostile smoke scenario",
            "capabilities": {
                "multi_room_capable": False,
                "adjacent_room_territory_signal": False,
                "hostile_combat_signal": False,
                "multi_tier_policy_comparison": False,
            },
            "suitability": {
                "multi_tier_policy_comparison": False,
                "territory_combat_differentiation": False,
                "classification": "not_suitable_for_territory_combat_differentiation",
                "reasons": ["single-room", "no-hostile"],
            },
            "evidence": {
                "anchor_room": "E1S1",
                "room_count": 1,
                "hostile_fixture": "none",
                "map_source_file": "maps/map-0b6758af.json",
            },
            "safety": {
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
                "ood_rejection": True,
                "conservative_actions_only": True,
            },
        },
        "strategy_variants": ["construction-priority.incumbent.v1"],
    }


def training_report_with_ready_runtime_scorecard() -> dict[str, object]:
    return {
        "reportId": "run-test",
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "artifactCount": 1,
        "runtimeParameterInjection": {
            "status": "injected",
            "runtimeParameterInjection": True,
            "runtimeParameterConsumption": True,
            "runtimeParameterConsumptionStatus": "consumed",
            "policyUpdateEligible": True,
            "candidateParameterScope": "runtime_injected",
            "injectedVariantCount": 1,
            "consumedVariantCount": 1,
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        },
        "scorecardId": "rl-scorecard-run-test",
        "scorecardArtifactPath": READY_RUNTIME_SCORECARD_PATH,
        "candidateScorecard": {
            "status": "ready",
            "scorecardId": "rl-scorecard-run-test",
            "runtimeParameterInjection": True,
            "injectedVariantCount": 1,
            "validationScaleComputeBlocked": False,
            "scorecardUsable": True,
        },
    }


def ready_runtime_candidate_scorecard_set() -> dict[str, object]:
    return {
        "type": runner.MULTI_CANDIDATE_SCORECARD_SET_TYPE,
        "schemaVersion": 1,
        "status": "ready",
        "classification": "runtime_injected_multi_candidate_scorecards_ready",
        "reportId": "run-test",
        "comparisonCount": 1,
        "candidateCount": 1,
        "baselineCount": 1,
        "candidateStrategyIds": ["candidate"],
        "baselineStrategyIds": ["baseline"],
        "selectedScorecardId": "rl-scorecard-run-test",
        "materializedScorecardCount": 1,
        "blockedComparisonCount": 0,
        "readyComparisonCount": 1,
        "validationScaleComputeBlocked": False,
        "scorecardUsable": True,
        "missingPrerequisites": [],
        "reasonCodes": ["runtime_injected_candidate_scorecard_ready"],
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "comparisons": [
            {
                "type": "screeps-rl-candidate-vs-baseline-scorecard-readiness",
                "schemaVersion": 1,
                "status": "ready",
                "classification": "runtime_injected_candidate_scorecard_ready",
                "scorecardId": "rl-scorecard-run-test",
                "scorecardArtifactPath": READY_RUNTIME_SCORECARD_PATH,
                "candidateStrategyId": "candidate",
                "baselineStrategyId": "baseline",
                "candidateRank": 1,
                "baselineRank": 2,
                "comparisonKey": "candidate::vs::baseline",
                "runtimeParameterInjection": True,
                "injectedVariantCount": 1,
                "candidateParameterScope": "runtime_injected",
                "reportRuntimeParameterInjection": True,
                "reportInjectedVariantCount": 1,
                "validationScaleComputeBlocked": False,
                "scorecardUsable": True,
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            }
        ],
    }


def ready_runtime_candidate_scorecard_matrix() -> dict[str, object]:
    candidate_ids = ["candidate-a", "candidate-b"]
    baseline_ids = ["baseline-a", "baseline-b"]
    base = ready_runtime_candidate_scorecard_set()
    template = base["comparisons"][0]
    comparisons: list[dict[str, object]] = []
    for candidate_index, candidate_id in enumerate(candidate_ids, start=1):
        for baseline_index, baseline_id in enumerate(baseline_ids, start=1):
            comparison = copy.deepcopy(template)
            scorecard_id = f"rl-scorecard-run-test-{candidate_id}-vs-{baseline_id}"
            comparison.update(
                {
                    "scorecardId": scorecard_id,
                    "scorecardArtifactPath": ready_runtime_pair_scorecard_path(
                        scorecard_id,
                        candidate_id,
                        baseline_id,
                    ),
                    "candidateStrategyId": candidate_id,
                    "baselineStrategyId": baseline_id,
                    "candidateRank": candidate_index,
                    "baselineRank": len(candidate_ids) + baseline_index,
                    "comparisonKey": f"{candidate_id}::vs::{baseline_id}",
                }
            )
            comparisons.append(comparison)
    return {
        **base,
        "comparisonCount": len(comparisons),
        "candidateCount": len(candidate_ids),
        "baselineCount": len(baseline_ids),
        "candidateStrategyIds": candidate_ids,
        "baselineStrategyIds": baseline_ids,
        "selectedScorecardId": comparisons[0]["scorecardId"],
        "materializedScorecardCount": len(comparisons),
        "readyComparisonCount": len(comparisons),
        "comparisons": comparisons,
    }


def write_tencent_guard_summary(
    artifact_root: Path,
    run_id: str,
    *,
    scenario_id: str = runner.DEFAULT_SCENARIO_ID,
    ticks: int = runner.POLICY_GRADIENT_MIN_SIMULATION_TICKS,
    final_status: str = "completed",
    territory_kills: tuple[tuple[float, float], ...] = ((2, 0), (2, 0)),
    room: str = "E1S1",
    map_source_file: str = "maps/map-0b6758af.json",
) -> Path:
    run_dir = artifact_root / run_id
    report_path = runner.remote_training_report_path(run_dir, run_id)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    card = generated_experiment_card()
    scenario = card["scenario"]
    assert isinstance(scenario, dict)
    if scenario_id == runner.MULTI_TIER_SCENARIO_ID:
        scenario = dict(scenario)
        scenario["scenario_id"] = runner.MULTI_TIER_SCENARIO_ID
        scenario["capabilities"] = {
            "multi_room_capable": True,
            "adjacent_room_territory_signal": True,
            "hostile_combat_signal": True,
            "multi_tier_policy_comparison": True,
        }
        scenario["suitability"] = {
            "multi_tier_policy_comparison": True,
            "territory_combat_differentiation": True,
            "classification": "suitable_for_multi_tier_policy_comparison",
            "reasons": [],
        }
    ranking = [
        {
            "variantId": f"variant-{index}",
            "rewardTuple": [1, territory, 0, kills],
        }
        for index, (territory, kills) in enumerate(territory_kills)
    ]
    variant_results = [
        {
            "variantId": item["variantId"],
            "reward": {"tuple": item["rewardTuple"]},
        }
        for item in ranking
    ]
    report = {
        "type": "screeps-rl-training-report",
        "reportId": run_id,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "artifactCount": len(variant_results),
        "rewardModel": {"componentOrder": ["reliability", "territory", "resources", "kills"]},
        "scenario": scenario,
        "simulation": {
            "ticks": ticks,
            "room": room,
            "mapSourceFile": map_source_file,
        },
        "source": {
            "initialConditions": {
                "ticks": ticks,
                "room": room,
                "mapSourceFile": map_source_file,
            }
        },
        "variantResults": variant_results,
        "ranking": ranking,
        "kpiSummary": {
            "territory": {"score": ranking[0]["rewardTuple"][1]},
            "kills": {"score": ranking[0]["rewardTuple"][3]},
        },
    }
    report_path.write_text(json.dumps(report), encoding="utf-8")
    summary = {
        "type": "screeps-tencent-batch-rl-run",
        "schemaVersion": 1,
        "runId": run_id,
        "finishedAt": "2026-05-18T00:00:00Z",
        "finalStatus": final_status,
        "inputs": {
            "ticks": ticks,
            "scenarioId": scenario_id,
            "trainingApproach": "policy_gradient",
        },
        "outputs": {
            "trainingReport": {
                "path": str(report_path),
                "reportId": run_id,
                "ranking": ranking,
                "simulation": report["simulation"],
            }
        },
    }
    summary_path = run_dir / "controller-summary.json"
    summary_path.write_text(json.dumps(summary), encoding="utf-8")
    return summary_path


def write_tencent_failure_summary(
    artifact_root: Path,
    run_id: str,
    *,
    failure_text: str | None = None,
    failure_class: str | None = runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
) -> Path:
    run_dir = artifact_root / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    stderr_tail = failure_text or (
        "pre-scale private-simulator trainability smoke gate failed: "
        "place-spawn room busy after 12 attempt(s): "
        '{"classification": "place_spawn_room_busy"}'
    )
    remote_failure: dict[str, object] = {
        "status": "failed_exit",
        "retryable": False,
        "returncode": 2,
        "artifactDir": str(run_dir / "remote"),
        "diagnostics": {
            "training-stderr.log": {
                "path": str(run_dir / "remote" / "training-stderr.log"),
                "bytes": len(stderr_tail),
                "tail": stderr_tail,
            }
        },
    }
    if failure_class is not None:
        remote_failure["failureClass"] = failure_class
    summary = {
        "type": "screeps-tencent-batch-rl-run",
        "schemaVersion": 1,
        "runId": run_id,
        "startedAt": "2026-05-29T19:45:03Z",
        "finishedAt": "2026-05-29T19:47:03Z",
        "partial": False,
        "finalStatus": "failed",
        "execution": {
            "command": "run-single",
            "mode": "compute",
            "preflightOnly": False,
            "computeAttempted": True,
            "scaleOutAttempted": True,
            "remoteTrainingAttempted": True,
            "trainingReportProduced": False,
            "environmentsRun": 0,
        },
        "safety": {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
            "billingGuardBeforeScale": True,
            "scaleDownAttempted": True,
            "secretsPrinted": False,
        },
        "outputs": {
            "error": f"BatchRunError: remote_training failed with exit 2: training-stderr.log: {stderr_tail}",
            "remoteTrainingFailure": remote_failure,
        },
        "steps": [
            {
                "name": "remote_training",
                "ok": False,
                "returncode": 2,
                "stdout_tail": "",
                "stderr_tail": stderr_tail,
                "detail": {"argv": ["ssh", "worker"]},
            },
            {
                "name": "scale_down",
                "ok": True,
                "returncode": 0,
                "stdout_tail": "{}",
                "stderr_tail": "",
                "detail": {"desiredCapacity": 0},
            },
        ],
    }
    summary_path = run_dir / "controller-summary.json"
    summary_path.write_text(json.dumps(summary), encoding="utf-8")
    return summary_path


def write_paid_failure_recurrence_skipped_summary(artifact_root: Path, run_id: str) -> Path:
    run_dir = artifact_root / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    summary = {
        "type": "screeps-tencent-batch-rl-run",
        "schemaVersion": 1,
        "runId": run_id,
        "startedAt": "2026-05-29T20:00:03Z",
        "finishedAt": "2026-05-29T20:00:04Z",
        "partial": False,
        "finalStatus": runner.PAID_FAILURE_RECURRENCE_GUARD_FINAL_STATUS,
        "execution": {
            "command": "run-single",
            "mode": "compute",
            "preflightOnly": False,
            "computeAttempted": False,
            "scaleOutAttempted": False,
            "remoteTrainingAttempted": False,
        },
        "outputs": {
            "launchGuard": {
                "status": "blocked",
                "activeGuard": "paid_failure_recurrence_guard",
                "activeSignature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
            }
        },
    }
    summary_path = run_dir / "controller-summary.json"
    summary_path.write_text(json.dumps(summary), encoding="utf-8")
    return summary_path


def write_post_fix_validation_summary(
    artifact_root: Path,
    run_id: str,
    *,
    final_status: str = "completed",
    failure_class: str | None = None,
) -> Path:
    if final_status == "completed":
        run_dir = artifact_root / run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        summary = {
            "type": "screeps-tencent-batch-rl-run",
            "schemaVersion": 1,
            "runId": run_id,
            "startedAt": "2026-05-29T21:00:03Z",
            "finishedAt": "2026-05-29T21:04:03Z",
            "partial": False,
            "finalStatus": "completed",
            "execution": {
                "command": "run-single",
                "mode": "compute",
                "preflightOnly": False,
                "computeAttempted": True,
                "scaleOutAttempted": True,
                "remoteTrainingAttempted": True,
                "trainingReportProduced": True,
            },
            "outputs": {},
        }
        summary_path = run_dir / "controller-summary.json"
    else:
        summary_path = write_tencent_failure_summary(
            artifact_root,
            run_id,
            failure_class=failure_class,
        )
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
    summary.setdefault("outputs", {})["launchGuard"] = {
        "status": runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_ALLOWED_STATUS,
        "blocked": False,
        "activeSignature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
        "postFixValidation": {
            "signature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
            "status": "allowed",
            "requested": True,
            "knownFix": {
                "issue": "#1501",
                "pullRequest": "#1504",
                "mergeCommit": "95f960b2",
                "present": True,
            },
            "priorAttempt": None,
        },
    }
    summary_path.write_text(json.dumps(summary), encoding="utf-8")
    return summary_path


def write_post_fix_validation_pre_scale_admission_failure_summary(
    artifact_root: Path,
    run_id: str,
    *,
    guard_status: str = runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_ALLOWED_STATUS,
    validation_status: str = "allowed",
) -> Path:
    run_dir = artifact_root / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    summary = {
        "type": "screeps-tencent-batch-rl-run",
        "schemaVersion": 1,
        "runId": run_id,
        "startedAt": "2026-05-29T23:59:27Z",
        "finishedAt": "2026-05-29T23:59:28Z",
        "partial": False,
        "finalStatus": "failed",
        "execution": {
            "command": "run-single",
            "mode": "compute",
            "preflightOnly": False,
            "computeAttempted": False,
            "scaleOutAttempted": False,
            "remoteTrainingAttempted": False,
            "trainingReportProduced": False,
            "environmentsRun": 0,
        },
        "outputs": {
            "error": (
                "CardValidationError: policy-gradient requestedSamplesPerCandidate=1 "
                "< target 20"
            ),
            "launchGuard": {
                "status": guard_status,
                "blocked": False,
                "activeSignature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                "postFixValidation": {
                    "signature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                    "status": validation_status,
                    "requested": True,
                    "knownFix": {
                        "issue": "#1501",
                        "pullRequest": "#1504",
                        "mergeCommit": "95f960b2",
                        "present": True,
                    },
                    "priorAttempt": None,
                },
            },
        },
    }
    summary_path = run_dir / "controller-summary.json"
    summary_path.write_text(json.dumps(summary), encoding="utf-8")
    return summary_path


def write_post_fix_validation_preflight_admission_summary(
    artifact_root: Path,
    run_id: str,
    *,
    guard_status: str = runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_RECOVERY_ALLOWED_STATUS,
    validation_status: str = "recovery_allowed",
) -> Path:
    summary_path = write_post_fix_validation_pre_scale_admission_failure_summary(
        artifact_root,
        run_id,
        guard_status=guard_status,
        validation_status=validation_status,
    )
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    summary["finalStatus"] = "preflight_ok"
    summary["execution"] = {
        "command": "preflight",
        "mode": "preflight",
        "preflightOnly": True,
        "computeAttempted": False,
        "scaleOutAttempted": False,
        "remoteTrainingAttempted": False,
        "trainingReportProduced": False,
        "environmentsRun": 0,
    }
    summary["inputs"] = {
        "command": "preflight",
        "executionMode": "preflight",
        "preflightOnly": True,
    }
    summary["outputs"].pop("error", None)
    summary_path.write_text(json.dumps(summary), encoding="utf-8")
    return summary_path


def write_post_fix_validation_in_progress_summary(artifact_root: Path, run_id: str) -> Path:
    summary_path = write_post_fix_validation_pre_scale_admission_failure_summary(
        artifact_root,
        run_id,
    )
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    summary["finishedAt"] = None
    summary["partial"] = True
    summary["finalStatus"] = "unknown"
    summary["outputs"].pop("error", None)
    summary_path.write_text(json.dumps(summary), encoding="utf-8")
    return summary_path


def write_post_fix_validation_remote_timeout_summary(artifact_root: Path, run_id: str) -> Path:
    summary_path = write_post_fix_validation_summary(
        artifact_root,
        run_id,
        final_status="failed",
        failure_class="remote_training_timeout",
    )
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    summary["startedAt"] = "2026-05-30T00:00:03Z"
    summary["finishedAt"] = "2026-05-30T00:02:03Z"
    timeout_tail = "validation heartbeat: environmentsStarted=5 environmentsCompleted=0"
    remote_failure = summary["outputs"]["remoteTrainingFailure"]
    remote_failure["returncode"] = runner.PROCESS_TIMEOUT_RETURN_CODE
    remote_failure["controllerTimedOut"] = True
    remote_failure["diagnostics"]["training-stderr.log"]["tail"] = timeout_tail
    remote_failure["diagnostics"]["training-stderr.log"]["bytes"] = len(timeout_tail)
    summary["outputs"]["error"] = (
        "BatchRunError: remote_training failed with exit 124: "
        "training-stderr.log: validation heartbeat"
    )
    summary["steps"][0]["returncode"] = runner.PROCESS_TIMEOUT_RETURN_CODE
    summary["steps"][0]["stderr_tail"] = timeout_tail
    summary_path.write_text(json.dumps(summary), encoding="utf-8")
    return summary_path


def write_post_fix_validation_recovery_remote_timeout_summary(artifact_root: Path, run_id: str) -> Path:
    summary_path = write_post_fix_validation_remote_timeout_summary(artifact_root, run_id)
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    launch_guard = summary["outputs"]["launchGuard"]
    launch_guard["status"] = runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_RECOVERY_ALLOWED_STATUS
    launch_guard["postFixValidation"]["status"] = "recovery_allowed"
    summary_path.write_text(json.dumps(summary), encoding="utf-8")
    return summary_path


def write_invalid_run_id_validation_admission_failure_summary(artifact_root: Path, run_id: str) -> Path:
    summary_path = write_post_fix_validation_pre_scale_admission_failure_summary(
        artifact_root,
        run_id,
    )
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    summary["outputs"]["error"] = (
        "BatchRunError: run id must be lowercase and contain only letters, numbers, dot, underscore, hyphen"
    )
    summary_path.write_text(json.dumps(summary), encoding="utf-8")
    return summary_path


def set_summary_finished_at(summary_path: Path, finished_at: str) -> None:
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    summary["finishedAt"] = finished_at
    summary_path.write_text(json.dumps(summary), encoding="utf-8")


def strip_tencent_guard_location_evidence(summary_path: Path) -> None:
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    training_report = summary["outputs"]["trainingReport"]
    report_path = Path(training_report["path"])
    report = json.loads(report_path.read_text(encoding="utf-8"))
    for container in (
        report.get("simulation"),
        runner.path_value(report, "source", "initialConditions"),
        training_report.get("simulation"),
    ):
        if isinstance(container, dict):
            for key in ("room", "mapSourceFile", "map_source_file"):
                container.pop(key, None)
    for scenario in (
        report.get("scenario"),
        runner.path_value(report, "experimentCard", "scenario"),
    ):
        evidence = runner.path_value(scenario, "evidence")
        if isinstance(evidence, dict):
            for key in ("anchor_room", "anchorRoom", "room", "map_source_file", "mapSourceFile"):
                evidence.pop(key, None)
    report_path.write_text(json.dumps(report), encoding="utf-8")
    summary_path.write_text(json.dumps(summary), encoding="utf-8")


class TencentBatchRlRunnerTest(unittest.TestCase):
    def run_stubbed_preflight(
        self,
        args: argparse.Namespace,
        artifact_dir: Path,
    ) -> tuple[list[str], runner.Controller, dict[str, object], dict[str, object]]:
        events: list[str] = []

        class FakeController(runner.Controller):
            def ensure_map_present(self) -> None:
                events.append("map")

            def ensure_dist_present(self) -> None:
                events.append("dist")

            def run_billing_guard(self) -> None:
                events.append("billing")

            def verify_security_group(self) -> None:
                events.append("security_group")

            def generate_experiment_card(self) -> None:
                events.append("experiment_card")

            def scale_up_and_wait(self) -> None:
                events.append("scale_up")

        controller = FakeController(args=args, run_id=args.run_id, artifact_dir=artifact_dir)
        with mock.patch.object(runner, "validate_static_inputs", return_value=None):
            controller.run()
        guard = json.loads((artifact_dir / "launch_guard.json").read_text(encoding="utf-8"))
        summary = json.loads((artifact_dir / "controller-summary.json").read_text(encoding="utf-8"))
        return events, controller, guard, summary

    def run_stubbed_compute(
        self,
        args: argparse.Namespace,
        artifact_dir: Path,
    ) -> tuple[list[str], runner.Controller, dict[str, object], dict[str, object]]:
        events: list[str] = []

        class FakeController(runner.Controller):
            def ensure_map_present(self) -> None:
                events.append("map")

            def ensure_dist_present(self) -> None:
                events.append("dist")

            def run_billing_guard(self) -> None:
                events.append("billing")

            def verify_security_group(self) -> None:
                events.append("security_group")

            def generate_experiment_card(self) -> None:
                events.append("experiment_card")

            def scale_up_and_wait(self) -> None:
                events.append("scale_up")
                self.scaled_up = True
                self.instance_id = "ins-test"
                self.public_ip = "203.0.113.10"
                self.record_step("scale_up", 100.0, True, desiredCapacity=1)

            def verify_worker_security(self) -> None:
                events.append("worker_security")

            def bootstrap_worker(self) -> None:
                events.append("bootstrap")

            def transfer_repo_bundle(self) -> None:
                events.append("repo_bundle")

            def transfer_secret_env(self) -> None:
                events.append("secret_env")

            def run_remote_training(self) -> None:
                events.append("remote_training")
                self.record_step("remote_training", 101.0, True, reportId=self.run_id)

            def collect_remote_artifacts(self) -> None:
                events.append("collect_artifacts")

            def verify_remote_training_report(self) -> None:
                events.append("verify_training_report")
                self.result["trainingReport"] = {
                    "path": str(self.artifact_dir / "remote" / "runtime-artifacts" / "rl-training" / f"{self.run_id}.json"),
                    "reportId": self.run_id,
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                    "artifactCount": 5,
                    "scaleValidation": {
                        "ok": True,
                        "totalEnvironments": 5,
                        "successfulEnvironments": 5,
                        "minimumSuccessfulEnvironments": 4,
                    },
                }

            def scale_down(self) -> None:
                events.append("scale_down")
                self.record_step("scale_down", 102.0, True, desiredCapacity=0)

        controller = FakeController(args=args, run_id=args.run_id, artifact_dir=artifact_dir)
        with mock.patch.object(runner, "validate_static_inputs", return_value=None):
            controller.run()
        guard = json.loads((artifact_dir / "launch_guard.json").read_text(encoding="utf-8"))
        summary = json.loads((artifact_dir / "controller-summary.json").read_text(encoding="utf-8"))
        return events, controller, guard, summary

    def test_controller_summary_records_pid_and_declared_timeout_window(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            args = controller_args()
            args.scale_timeout_seconds = 1200
            args.scale_down_timeout_seconds = 900
            args.bootstrap_timeout_seconds = 1800
            args.training_timeout_seconds = 7200
            args.transfer_timeout_seconds = 1200
            controller = runner.Controller(
                args=args,
                run_id="tencent-pg-20260521t091504z",
                artifact_dir=Path(temp_dir) / "run",
            )

            controller.write_summary(partial=True)

            summary = json.loads((controller.artifact_dir / "controller-summary.json").read_text(encoding="utf-8"))

        self.assertEqual(summary["controllerProcess"]["pid"], os.getpid())
        self.assertEqual(
            summary["inputs"]["executionTimeouts"],
            {
                "bootstrapTimeoutSeconds": 1800,
                "scaleDownTimeoutSeconds": 900,
                "scaleTimeoutSeconds": 1200,
                "totalSeconds": 12300,
                "trainingTimeoutSeconds": 7200,
                "transferTimeoutSeconds": 1200,
            },
        )

    def test_controller_summary_resolves_policy_gradient_legacy_default_to_scenario_v1(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            args = controller_args()
            args.training_approach = "policy_gradient"
            args.scenario_id = legacy_multi_tier_scenario_id()
            controller = runner.Controller(
                args=args,
                run_id="tencent-pg-20260529t093003z",
                artifact_dir=Path(temp_dir) / "run",
            )

            controller.write_summary(partial=True)

            summary = json.loads((controller.artifact_dir / "controller-summary.json").read_text(encoding="utf-8"))

        self.assertEqual(args.scenario_id, runner.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(args.require_multi_tier_scenario)
        self.assertEqual(summary["inputs"]["trainingApproach"], "policy_gradient")
        self.assertEqual(summary["inputs"]["scenarioId"], runner.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(summary["inputs"]["requireMultiTierScenario"])

    def test_run_cp_records_timeout_as_failed_step(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=Path(temp_dir))
            timeout_error = subprocess.TimeoutExpired(
                ["ssh", "worker"],
                7,
                output=b"partial stdout",
                stderr=b"partial stderr",
            )

            with mock.patch("subprocess.run", side_effect=timeout_error):
                cp = controller.run_cp("remote_training", ["ssh", "worker"], check=False, timeout=7)

            summary = json.loads((controller.artifact_dir / "controller-summary.json").read_text(encoding="utf-8"))

        self.assertEqual(cp.returncode, runner.PROCESS_TIMEOUT_RETURN_CODE)
        self.assertEqual(cp.stdout, "partial stdout")
        self.assertIn("TimeoutExpired: command timed out after 7 seconds", cp.stderr)
        self.assertIn("partial stderr", cp.stderr)
        self.assertTrue(summary["partial"])
        self.assertTrue(summary["execution"]["remoteTrainingAttempted"])
        self.assertFalse(summary["execution"]["trainingReportProduced"])
        self.assertEqual(summary["execution"]["environmentsRun"], 0)
        step = summary["steps"][0]
        self.assertEqual(step["name"], "remote_training")
        self.assertFalse(step["ok"])
        self.assertEqual(step["returncode"], runner.PROCESS_TIMEOUT_RETURN_CODE)
        self.assertIn("TimeoutExpired: command timed out after 7 seconds", step["stderr_tail"])
        self.assertNotIn("['ssh', 'worker']", step["stderr_tail"])
        self.assertTrue(step["detail"]["controllerTimedOut"])

    def test_security_group_guard_accepts_single_controller_ssh_rule(self) -> None:
        ingress = [
            {"Action": "ACCEPT", "Protocol": "TCP", "Port": "22", "CidrBlock": CONTROLLER_IP},
            {"Action": "DROP", "Protocol": "ALL", "Port": "ALL", "CidrBlock": "0.0.0.0/0"},
        ]

        self.assertEqual(runner.validate_controller_only_sg_ssh_ingress(ingress, CONTROLLER_IP), [ingress[0]])

    def test_security_group_guard_accepts_controller_host_ip_equivalent_to_32(self) -> None:
        ingress = [{"Action": "ACCEPT", "Protocol": "tcp", "Port": "22", "CidrBlock": CONTROLLER_IP}]

        self.assertEqual(runner.validate_controller_only_sg_ssh_ingress(ingress, CONTROLLER_IP_HOST), [ingress[0]])

    def test_security_group_guard_accepts_controller_32_equivalent_to_host_ip(self) -> None:
        ingress = [{"Action": "ACCEPT", "Protocol": "tcp", "Port": "22", "CidrBlock": CONTROLLER_IP_HOST}]

        self.assertEqual(runner.validate_controller_only_sg_ssh_ingress(ingress, CONTROLLER_IP), [ingress[0]])

    def test_security_group_guard_rejects_all_protocol_broad_ssh(self) -> None:
        ingress = [
            {"Action": "ACCEPT", "Protocol": "TCP", "Port": "22", "CidrBlock": CONTROLLER_IP},
            {"Action": "ACCEPT", "Protocol": "ALL", "Port": "ALL", "CidrBlock": "0.0.0.0/0"},
        ]

        with self.assertRaisesRegex(runner.BatchRunError, "controller-only"):
            runner.validate_controller_only_sg_ssh_ingress(ingress, CONTROLLER_IP)

    def test_worker_iptables_guard_accepts_controller_rule_with_ssh_drop_closure(self) -> None:
        output = (
            "iptables=-P INPUT ACCEPT;"
            "-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT;"
            f"-A INPUT -p tcp -s {CONTROLLER_IP} --dport 22 -j ACCEPT;"
            "-A INPUT -p tcp --dport 22 -j DROP;\n"
            "sshd=passwordauthentication no;"
        )

        runner.validate_controller_only_worker_ssh(output, CONTROLLER_IP)

    def test_worker_iptables_guard_rejects_broad_ssh_accept(self) -> None:
        output = (
            "iptables=-P INPUT DROP;"
            f"-A INPUT -p tcp -s {CONTROLLER_IP} --dport 22 -j ACCEPT;"
            "-A INPUT -p tcp --dport 22 -j ACCEPT;\n"
            "sshd=passwordauthentication no;"
        )

        with self.assertRaisesRegex(runner.BatchRunError, "controller-only"):
            runner.validate_controller_only_worker_ssh(output, CONTROLLER_IP)

    def test_worker_iptables_guard_rejects_broad_ssh_accept_in_jumped_chain(self) -> None:
        output = (
            "iptables_filter=*filter;"
            ":INPUT DROP [0:0];"
            ":ufw-user-input - [0:0];"
            "-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT;"
            "-A INPUT -j ufw-user-input;"
            f"-A ufw-user-input -p tcp -s {CONTROLLER_IP} --dport 22 -j ACCEPT;"
            "-A ufw-user-input -p tcp --dport 22 -j ACCEPT;"
            "COMMIT;\n"
            "sshd=passwordauthentication no;"
        )

        with self.assertRaisesRegex(runner.BatchRunError, "controller-only"):
            runner.validate_controller_only_worker_ssh(output, CONTROLLER_IP)

    def test_worker_iptables_guard_accepts_controller_only_full_ruleset(self) -> None:
        output = (
            "iptables_filter=*filter;"
            ":INPUT DROP [0:0];"
            ":ufw-user-input - [0:0];"
            "-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT;"
            "-A INPUT -j ufw-user-input;"
            f"-A ufw-user-input -p tcp -s {CONTROLLER_IP} --dport 22 -j ACCEPT;"
            "-A ufw-user-input -p tcp --dport 22 -j DROP;"
            "COMMIT;\n"
            "sshd=passwordauthentication no;"
        )

        runner.validate_controller_only_worker_ssh(output, CONTROLLER_IP)

    def test_worker_iptables_guard_accepts_controller_only_sg_closure_for_open_host_firewall(self) -> None:
        ingress = [{"Action": "ACCEPT", "Protocol": "tcp", "Port": "22", "CidrBlock": CONTROLLER_IP}]
        output = (
            "iptables_filter=# Generated by iptables-save v1.8.10 (nf_tables) on Thu May 28 06:35:58 2026;"
            "*filter;"
            ":INPUT ACCEPT [0:0];"
            ":FORWARD ACCEPT [0:0];"
            ":OUTPUT ACCEPT [0:0];"
            "COMMIT;"
            "# Completed on Thu May 28 06:35:58 2026;\n"
            "sshd=passwordauthentication no;"
        )

        runner.validate_controller_only_worker_ssh(output, CONTROLLER_IP_HOST, sg_ssh_ingress=ingress)

    def test_worker_iptables_guard_rejects_broad_accept_with_controller_only_sg_closure(self) -> None:
        ingress = [{"Action": "ACCEPT", "Protocol": "tcp", "Port": "22", "CidrBlock": CONTROLLER_IP}]
        output = "iptables=-P INPUT ACCEPT;-A INPUT -p tcp --dport 22 -j ACCEPT;\n"

        with self.assertRaisesRegex(runner.BatchRunError, "controller-only"):
            runner.validate_controller_only_worker_ssh(output, CONTROLLER_IP_HOST, sg_ssh_ingress=ingress)

    def test_worker_iptables_guard_requires_ssh_closure_when_default_policy_accepts(self) -> None:
        output = f"iptables=-P INPUT ACCEPT;-A INPUT -p tcp -s {CONTROLLER_IP} --dport 22 -j ACCEPT;\n"

        with self.assertRaisesRegex(runner.BatchRunError, "controller-only"):
            runner.validate_controller_only_worker_ssh(output, CONTROLLER_IP)

    def test_repo_bundle_uses_tracked_manifest_plus_required_map(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_git(["init", "-q"], root)
            write_text(root / ".gitignore", ".env\n*.local\nprod/.env\n")
            write_text(root / "scripts" / "tracked.py")
            write_text(root / "prod" / "dist" / "main.js", "bundle\n")
            write_text(root / "maps" / "map-0b6758af.json", "{}\n")
            write_text(root / ".env", "TOKEN=secret\n")
            write_text(root / "prod" / ".env", "TOKEN=secret\n")
            write_text(root / "scratch.local", "TOKEN=secret\n")
            write_text(root / "credential.json", '{"token":"secret"}\n')
            run_git(["add", ".gitignore", "scripts/tracked.py", "prod/dist/main.js"], root)

            package = root / "out" / "repo-bundle.tar.gz"
            with mock.patch.object(runner, "REPO_ROOT", root):
                runner.create_repo_bundle(package)

            with tarfile.open(package, "r:gz") as tar:
                names = set(tar.getnames())
            self.assertIn(".gitignore", names)
            self.assertIn("scripts/tracked.py", names)
            self.assertIn("prod/dist/main.js", names)
            self.assertIn("maps/map-0b6758af.json", names)
            self.assertNotIn(".env", names)
            self.assertNotIn("prod/.env", names)
            self.assertNotIn("scratch.local", names)
            self.assertNotIn("credential.json", names)

    def test_repo_bundle_rejects_tracked_secret_like_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_git(["init", "-q"], root)
            write_text(root / ".gitignore")
            write_text(root / "ops-credentials.json", '{"token":"secret"}\n')
            run_git(["add", ".gitignore", "ops-credentials.json"], root)

            with mock.patch.object(runner, "REPO_ROOT", root):
                with self.assertRaisesRegex(runner.BatchRunError, "secret-like"):
                    runner.create_repo_bundle(root / "repo-bundle.tar.gz")

    def test_safe_extract_tar_extracts_regular_artifact_layout(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            tar_path = root / "remote-artifacts.tar.gz"
            write_tar(tar_path, lambda tar: add_file(tar, "runtime-artifacts/rl-training/run-1.json", b"{}"))

            extract_dir = root / "remote"
            runner.safe_extract_tar(tar_path, extract_dir)

            self.assertEqual((extract_dir / "runtime-artifacts" / "rl-training" / "run-1.json").read_text(encoding="utf-8"), "{}")
            self.assertEqual(
                runner.remote_training_report_path(root, "run-1"),
                root / "remote" / "runtime-artifacts" / "rl-training" / "run-1.json",
            )

    def test_safe_policy_update_artifact_path_accepts_candidate_json(self) -> None:
        artifact_path = runner.safe_policy_update_artifact_path(
            "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
        )

        self.assertEqual(
            artifact_path,
            Path("runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"),
        )

    def test_safe_policy_update_artifact_path_rejects_non_candidate_or_unsafe_paths(self) -> None:
        cases = (
            ("runtime-artifacts/rl-training/run-test.json", "outside rl-training policy candidate artifacts"),
            ("runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.txt", "JSON policy candidate"),
            ("/runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json", "unsafe"),
            ("runtime-artifacts/rl-training/policy-candidates/../run-test-next-policy.json", "unsafe"),
            ("runtime-artifacts\\rl-training\\policy-candidates\\run-test-next-policy.json", "unsafe"),
        )
        for raw, expected_error in cases:
            with self.subTest(raw=raw), self.assertRaisesRegex(runner.BatchRunError, expected_error):
                runner.safe_policy_update_artifact_path(raw)

    def test_write_policy_update_artifact_preserves_intentional_falsy_promotion_gate(self) -> None:
        artifact_path = "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_policy_update_artifact(root, artifact_path, {"territorySignalWeight": 7}, promotion_gate=False)
            payload = json.loads((root / "remote" / artifact_path).read_text(encoding="utf-8"))

        self.assertIs(payload["promotionGate"], False)

    def test_verified_remote_policy_update_accepts_empty_zero_iteration_update(self) -> None:
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        cases = (
            {},
            {"policyUpdateIterations": 0},
            {"policyUpdate": None},
            {"policyUpdate": {}},
            {"policyUpdate": []},
            {"policyUpdateIterations": 0, "policyUpdate": None},
            {"policyUpdateIterations": 0, "policyUpdate": {}},
            {"policyUpdateIterations": 0, "policyUpdate": []},
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            for data in cases:
                with self.subTest(data=data):
                    self.assertEqual(
                        runner.verified_remote_policy_update_fields(data, top_level_safety, Path(temp_dir)),
                        {
                            "policyUpdateIterations": 0,
                            "policyUpdateArtifactPath": None,
                            "policyUpdate": None,
                        },
                    )

    def test_verified_remote_policy_update_accepts_structured_zero_iteration_noop_update(self) -> None:
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        policy_update = {
            "type": "screeps-rl-policy-update",
            "schemaVersion": 1,
            "iterations": 0,
            "algorithm": "rank_weighted_finite_difference_v1",
            "targetFamily": "test-family",
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
            "safety": {
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
                "officialMmoControl": False,
            },
            "skippedReason": "no_nonzero_reward_advantage",
            "candidateCount": 2,
            "anchor": {
                "candidatePolicyId": "candidate-a",
                "strategyVariantId": "variant-a",
                "rolloutStatus": "incumbent",
                "rewardTuple": [1, 0, 0, 0],
                "sampleCount": 1,
                "parameters": {"territorySignalWeight": 1.0},
            },
            "candidateRewards": [
                {
                    "candidatePolicyId": "candidate-a",
                    "strategyVariantId": "variant-a",
                    "rolloutStatus": "incumbent",
                    "rewardTuple": [1, 0, 0, 0],
                    "sampleCount": 1,
                    "parameters": {"territorySignalWeight": 1.0},
                },
                {
                    "candidatePolicyId": "candidate-b",
                    "strategyVariantId": "variant-b",
                    "rolloutStatus": "shadow",
                    "rewardTuple": [1, 0, 0, 0],
                    "sampleCount": 1,
                    "parameters": {"territorySignalWeight": 2.0},
                },
            ],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            self.assertEqual(
                runner.verified_remote_policy_update_fields(
                    {"policyUpdateIterations": 0, "policyUpdate": policy_update},
                    top_level_safety,
                    Path(temp_dir),
                ),
                {
                    "policyUpdateIterations": 0,
                    "policyUpdateArtifactPath": None,
                    "policyUpdate": policy_update,
                },
            )

    def test_verified_remote_policy_update_accepts_metadata_only_zero_iteration_noop_update(self) -> None:
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        policy_update = {
            "type": "screeps-rl-policy-update",
            "schemaVersion": 1,
            "iterations": 0,
            "algorithm": "true_gradient_reinforce_v1",
            "targetFamily": "multi-tier-territory-combat",
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
            "safety": {
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            },
            "skippedReason": "candidate_parameters_metadata_only",
            "candidateCount": 0,
            "metadataCandidateCount": 5,
            "parameterEvidence": {
                "candidateParameterScope": "metadata_only",
                "runtimeParameterInjection": False,
                "policyUpdateEligible": False,
                "reason": "candidate vectors were metadata only",
            },
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            self.assertEqual(
                runner.verified_remote_policy_update_fields(
                    {"policyUpdateIterations": 0, "policyUpdate": policy_update},
                    top_level_safety,
                    Path(temp_dir),
                ),
                {
                    "policyUpdateIterations": 0,
                    "policyUpdateArtifactPath": None,
                    "policyUpdate": policy_update,
                },
            )

    def test_verified_remote_policy_update_rejects_non_empty_zero_iteration_update(self) -> None:
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        cases = (
            (
                {"policyUpdate": {"nextCandidatePolicy": {}}},
                "policyUpdate is present without positive policyUpdateIterations",
            ),
            (
                {"policyUpdateIterations": 0, "policyUpdate": {"nextCandidatePolicy": {}}},
                "policyUpdate is present without positive policyUpdateIterations",
            ),
            (
                {"policyUpdateIterations": 0, "policyUpdate": {"iterations": 0}},
                "policyUpdate is present without positive policyUpdateIterations",
            ),
            (
                {"policyUpdateIterations": 0, "policyUpdate": [{"iterations": 0}]},
                "policyUpdate is present without positive policyUpdateIterations",
            ),
            (
                {
                    "policyUpdateIterations": 0,
                    "policyUpdate": {
                        "iterations": 0,
                        "skippedReason": "no_nonzero_reward_advantage",
                        "nextCandidatePolicy": {},
                    },
                },
                "zero-iteration no-op contains update data",
            ),
            (
                {
                    "policyUpdateIterations": 0,
                    "policyUpdate": {
                        "iterations": 0,
                        "skippedReason": "bounded_update_no_parameter_change",
                        "updatedParameters": {"territorySignalWeight": 2},
                    },
                },
                "zero-iteration no-op contains update data",
            ),
            (
                {
                    "policyUpdateIterations": 0,
                    "policyUpdate": {
                        "iterations": 0,
                        "skippedReason": "no_nonzero_reward_advantage",
                        "metadataCandidateCount": 5,
                        "parameterEvidence": {
                            "candidateParameterScope": "metadata_only",
                            "runtimeParameterInjection": False,
                            "policyUpdateEligible": False,
                        },
                        "unexpectedField": True,
                    },
                },
                "zero-iteration no-op has unexpected fields",
            ),
            (
                {"policyUpdate": {"iterations": -1}},
                "policyUpdate.iterations invalid",
            ),
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            for data, expected_error in cases:
                with self.subTest(data=data), self.assertRaisesRegex(runner.BatchRunError, expected_error):
                    runner.verified_remote_policy_update_fields(data, top_level_safety, Path(temp_dir))

    def test_verified_remote_policy_update_rejects_artifact_path_without_positive_iterations(self) -> None:
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        artifact_path = "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
        cases = (
            {"policyUpdateArtifactPath": artifact_path},
            {"policyUpdateIterations": 0, "policyUpdateArtifactPath": artifact_path},
            {"policyUpdateIterations": 0, "policyUpdate": {}, "policyUpdateArtifactPath": artifact_path},
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            for data in cases:
                with self.subTest(data=data), self.assertRaisesRegex(
                    runner.BatchRunError,
                    "policyUpdateArtifactPath is present without positive policyUpdateIterations",
                ):
                    runner.verified_remote_policy_update_fields(data, top_level_safety, Path(temp_dir))

    def test_verified_remote_policy_update_accepts_positive_update_with_collected_artifact(self) -> None:
        artifact_path = "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        policy_update = positive_policy_update(artifact_path)
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_policy_update_artifact(root, artifact_path, policy_update["updatedParameters"])

            self.assertEqual(
                runner.verified_remote_policy_update_fields(
                    {
                        "policyUpdateIterations": 1,
                        "policyUpdateArtifactPath": artifact_path,
                        "policyUpdate": policy_update,
                    },
                    top_level_safety,
                    root,
                    runtime_parameter_injection=ready_runtime_parameter_injection(),
                ),
                {
                    "policyUpdateIterations": 1,
                    "policyUpdateArtifactPath": artifact_path,
                    "policyUpdatePromotionGate": policy_update["promotionGate"],
                    "policyUpdate": policy_update,
                },
            )

    def test_verified_remote_policy_update_accepts_non_consumed_scorecard_update_as_non_promotional(self) -> None:
        artifact_path = "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        policy_update = positive_policy_update(artifact_path)
        gate = non_consumed_promotion_gate()
        policy_update["promotionGate"] = copy.deepcopy(gate)
        next_candidate = policy_update["nextCandidatePolicy"]
        assert isinstance(next_candidate, dict)
        next_candidate["promotionGate"] = copy.deepcopy(gate)
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_policy_update_artifact(root, artifact_path, policy_update["updatedParameters"], gate)

            verified = runner.verified_remote_policy_update_fields(
                {
                    "policyUpdateIterations": 1,
                    "policyUpdateArtifactPath": artifact_path,
                    "policyUpdate": policy_update,
                },
                top_level_safety,
                root,
                runtime_parameter_injection=missing_consumption_runtime_parameter_injection(),
            )

        promotion_gate = verified["policyUpdatePromotionGate"]
        assert isinstance(promotion_gate, dict)
        self.assertFalse(promotion_gate["runtimeParameterConsumption"])
        self.assertFalse(promotion_gate["loopAPromotionEligible"])
        self.assertFalse(promotion_gate["loopBPromotionEligible"])
        self.assertEqual(promotion_gate["missingPrerequisites"], ["runtime_parameter_consumption"])

    def test_verified_remote_policy_update_accepts_high_variance_consumed_update_as_non_promotional(self) -> None:
        artifact_path = "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        policy_update = positive_policy_update(artifact_path)
        gate = high_variance_consumed_promotion_gate()
        policy_update.update(
            {
                "gradientStable": False,
                "trustedGradientUpdate": False,
                "highVariance": True,
                "gradientStability": copy.deepcopy(gate["gradientStability"]),
                "promotionGate": copy.deepcopy(gate),
            }
        )
        next_candidate = policy_update["nextCandidatePolicy"]
        assert isinstance(next_candidate, dict)
        next_candidate.update(
            {
                "gradientStable": False,
                "trustedGradientUpdate": False,
                "highVariance": True,
                "gradientStability": copy.deepcopy(gate["gradientStability"]),
                "promotionGate": copy.deepcopy(gate),
            }
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_policy_update_artifact(root, artifact_path, policy_update["updatedParameters"], gate)

            verified = runner.verified_remote_policy_update_fields(
                {
                    "policyUpdateIterations": 1,
                    "policyUpdateArtifactPath": artifact_path,
                    "trustedGradientUpdate": False,
                    "gradientStable": False,
                    "highVariance": True,
                    "gradientStability": copy.deepcopy(gate["gradientStability"]),
                    "policyUpdate": policy_update,
                },
                top_level_safety,
                root,
                runtime_parameter_injection=ready_runtime_parameter_injection(),
            )

        promotion_gate = verified["policyUpdatePromotionGate"]
        assert isinstance(promotion_gate, dict)
        self.assertTrue(promotion_gate["runtimeParameterConsumption"])
        self.assertFalse(promotion_gate["runtimeConsumedPromotionEligible"])
        self.assertFalse(promotion_gate["loopAPromotionEligible"])
        self.assertFalse(promotion_gate["loopBPromotionEligible"])
        self.assertEqual(promotion_gate["missingPrerequisites"], ["gradient_stability"])
        self.assertFalse(verified["trustedGradientUpdate"])
        self.assertTrue(verified["highVariance"])

    def test_verified_remote_policy_update_rejects_missing_consumption_key_for_injected_proof(self) -> None:
        artifact_path = "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        policy_update = positive_policy_update(artifact_path)
        gate = non_consumed_promotion_gate()
        policy_update["promotionGate"] = copy.deepcopy(gate)
        next_candidate = policy_update["nextCandidatePolicy"]
        assert isinstance(next_candidate, dict)
        next_candidate["promotionGate"] = copy.deepcopy(gate)
        runtime_parameter_injection = missing_consumption_runtime_parameter_injection()
        runtime_parameter_injection.pop("runtimeParameterConsumption")
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_policy_update_artifact(root, artifact_path, policy_update["updatedParameters"], gate)

            with self.assertRaisesRegex(
                runner.BatchRunError,
                "runtimeParameterInjection.runtimeParameterConsumption",
            ):
                runner.verified_remote_policy_update_fields(
                    {
                        "policyUpdateIterations": 1,
                        "policyUpdateArtifactPath": artifact_path,
                        "policyUpdate": policy_update,
                    },
                    top_level_safety,
                    root,
                    runtime_parameter_injection=runtime_parameter_injection,
                )

    def test_verified_remote_policy_update_rejects_non_consumed_scorecard_update_claiming_runtime_consumption(
        self,
    ) -> None:
        artifact_path = "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        policy_update = positive_policy_update(artifact_path)
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_policy_update_artifact(root, artifact_path, policy_update["updatedParameters"])

            with self.assertRaisesRegex(
                runner.BatchRunError,
                "claims runtime consumption without top-level consumption proof",
            ):
                runner.verified_remote_policy_update_fields(
                    {
                        "policyUpdateIterations": 1,
                        "policyUpdateArtifactPath": artifact_path,
                        "policyUpdate": policy_update,
                    },
                    top_level_safety,
                    root,
                    runtime_parameter_injection=missing_consumption_runtime_parameter_injection(),
                )

    def test_verified_remote_policy_update_rejects_non_numeric_policy_parameter_values(self) -> None:
        artifact_path = "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }

        cases = []
        for label, value in (
            ("string", "7"),
            ("bool", True),
            ("infinity", float("inf")),
        ):
            policy_update = positive_policy_update(artifact_path)
            updated_parameters = policy_update["updatedParameters"]
            assert isinstance(updated_parameters, dict)
            updated_parameters["territorySignalWeight"] = value
            policy_update["nextCandidatePolicy"] = {
                **policy_update["nextCandidatePolicy"],
                "parameters": copy.deepcopy(updated_parameters),
            }
            cases.append((label, policy_update, "policyUpdate.updatedParameters values must be finite numbers"))

        next_bool_policy_update = positive_policy_update(artifact_path)
        next_candidate = next_bool_policy_update["nextCandidatePolicy"]
        assert isinstance(next_candidate, dict)
        next_parameters = next_candidate["parameters"]
        assert isinstance(next_parameters, dict)
        next_parameters["baseScoreWeight"] = True
        cases.append(
            (
                "next candidate bool",
                next_bool_policy_update,
                "policyUpdate.nextCandidatePolicy.parameters values must be finite numbers",
            )
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            for label, policy_update, expected_error in cases:
                write_policy_update_artifact(root, artifact_path, policy_update["updatedParameters"])
                with self.subTest(label=label), self.assertRaisesRegex(
                    runner.BatchRunError,
                    re.escape(expected_error),
                ):
                    runner.verified_remote_policy_update_fields(
                        {
                            "policyUpdateIterations": 1,
                            "policyUpdateArtifactPath": artifact_path,
                            "policyUpdate": policy_update,
                        },
                        top_level_safety,
                        root,
                    )

    def test_verified_remote_policy_update_rejects_stale_persisted_artifact_parameters(self) -> None:
        artifact_path = "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        policy_update = positive_policy_update(artifact_path)
        stale_parameters = copy.deepcopy(policy_update["updatedParameters"])
        assert isinstance(stale_parameters, dict)
        stale_parameters["territorySignalWeight"] = 6
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_policy_update_artifact(root, artifact_path, stale_parameters)

            with self.assertRaisesRegex(
                runner.BatchRunError,
                "policy update artifact parameters disagree with policyUpdate.updatedParameters",
            ):
                runner.verified_remote_policy_update_fields(
                    {
                        "policyUpdateIterations": 1,
                        "policyUpdateArtifactPath": artifact_path,
                        "policyUpdate": policy_update,
                    },
                    top_level_safety,
                    root,
                    runtime_parameter_injection=ready_runtime_parameter_injection(),
                )

    def test_verified_remote_policy_update_rejects_positive_update_without_parameter_change(self) -> None:
        artifact_path = "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        cases = (
            ("updatedParameters", {**positive_policy_update(artifact_path), "updatedParameters": {}}),
            (
                "nextCandidatePolicy.parameters",
                {
                    **positive_policy_update(artifact_path),
                    "nextCandidatePolicy": {
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": False,
                    },
                },
            ),
            ("at least one non-zero change", {**positive_policy_update(artifact_path), "parameterDelta": {"territorySignalWeight": 0}}),
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_text(root / "remote" / artifact_path, "{}\n")
            for expected_error, policy_update in cases:
                with self.subTest(expected_error=expected_error), self.assertRaisesRegex(
                    runner.BatchRunError,
                    re.escape(expected_error),
                ):
                    runner.verified_remote_policy_update_fields(
                        {
                            "policyUpdateIterations": 1,
                            "policyUpdateArtifactPath": artifact_path,
                            "policyUpdate": policy_update,
                        },
                        top_level_safety,
                        root,
                    )

    def test_verified_remote_policy_update_rejects_positive_update_without_explicit_policy_update_safety_flags(self) -> None:
        artifact_path = "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }

        def valid_policy_update() -> dict[str, object]:
            return positive_policy_update(artifact_path)

        missing_live_effect = valid_policy_update()
        missing_live_effect.pop("liveEffect")
        non_false_writes_allowed = valid_policy_update()
        non_false_writes_allowed["officialMmoWritesAllowed"] = None
        cases = (
            (missing_live_effect, "policyUpdate.liveEffect"),
            (non_false_writes_allowed, "policyUpdate.officialMmoWritesAllowed"),
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_text(root / "remote" / artifact_path, "{}\n")
            for policy_update, expected_error in cases:
                with self.subTest(expected_error=expected_error), self.assertRaisesRegex(
                    runner.BatchRunError,
                    re.escape(expected_error),
                ):
                    runner.verified_remote_policy_update_fields(
                        {
                            "policyUpdateIterations": 1,
                            "policyUpdateArtifactPath": artifact_path,
                            "policyUpdate": policy_update,
                        },
                        top_level_safety,
                        root,
                    )

    def test_verified_remote_policy_update_rejects_positive_update_without_explicit_next_candidate_safety_flags(self) -> None:
        artifact_path = "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }

        def valid_policy_update() -> dict[str, object]:
            return positive_policy_update(artifact_path)

        missing_writes = valid_policy_update()
        next_candidate = missing_writes["nextCandidatePolicy"]
        assert isinstance(next_candidate, dict)
        next_candidate.pop("officialMmoWrites")
        non_false_live_effect = valid_policy_update()
        next_candidate = non_false_live_effect["nextCandidatePolicy"]
        assert isinstance(next_candidate, dict)
        next_candidate["liveEffect"] = None
        cases = (
            (missing_writes, "policyUpdate.nextCandidatePolicy.officialMmoWrites"),
            (non_false_live_effect, "policyUpdate.nextCandidatePolicy.liveEffect"),
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_text(root / "remote" / artifact_path, "{}\n")
            for policy_update, expected_error in cases:
                with self.subTest(expected_error=expected_error), self.assertRaisesRegex(
                    runner.BatchRunError,
                    re.escape(expected_error),
                ):
                    runner.verified_remote_policy_update_fields(
                        {
                            "policyUpdateIterations": 1,
                            "policyUpdateArtifactPath": artifact_path,
                            "policyUpdate": policy_update,
                        },
                        top_level_safety,
                        root,
                    )

    def test_verify_remote_training_report_rejects_any_unsafe_flag(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(
                json.dumps(
                    {
                        "reportId": "run-test",
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": True,
                        "artifactCount": 1,
                    }
                ),
                encoding="utf-8",
            )
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            with self.assertRaisesRegex(runner.BatchRunError, "officialMmoWritesAllowed"):
                controller.verify_remote_training_report()

    def test_verify_remote_training_report_rejects_unsafe_nested_policy_update_flags(self) -> None:
        unsafe_updates = [
            ("policyUpdate.liveEffect=true", {"iterations": 1, "liveEffect": True}),
            ("policyUpdate.liveEffect=\"true\"", {"iterations": 1, "liveEffect": "true"}),
            (
                "policyUpdate.nextCandidatePolicy.official_mmo_writes_allowed=true",
                {
                    "iterations": 1,
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                    "nextCandidatePolicy": {"official_mmo_writes_allowed": True},
                },
            ),
            (
                "policyUpdate.nextCandidatePolicy.official_mmo_writes_allowed=1",
                {
                    "iterations": 1,
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                    "nextCandidatePolicy": {"official_mmo_writes_allowed": 1},
                },
            ),
            (
                "policyUpdate.nextCandidatePolicy.liveEffect=null",
                {
                    "iterations": 1,
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                    "nextCandidatePolicy": {"liveEffect": None},
                },
            ),
        ]
        for expected_error, policy_update in unsafe_updates:
            with self.subTest(expected_error=expected_error), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                report = runner.remote_training_report_path(root, "run-test")
                report.parent.mkdir(parents=True, exist_ok=True)
                report.write_text(
                    json.dumps(
                        {
                            "reportId": "run-test",
                            "liveEffect": False,
                            "officialMmoWrites": False,
                            "officialMmoWritesAllowed": False,
                            "artifactCount": 1,
                            "policyUpdate": policy_update,
                        }
                    ),
                    encoding="utf-8",
                )
                controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

                with self.assertRaisesRegex(runner.BatchRunError, re.escape(expected_error)):
                    controller.verify_remote_training_report()

    def test_verify_remote_training_report_rejects_positive_policy_update_without_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(
                json.dumps(
                    {
                        "reportId": "run-test",
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": False,
                        "artifactCount": 1,
                        "runtimeParameterInjection": ready_runtime_parameter_injection(),
                        "policyUpdateIterations": 1,
                        "policyUpdateArtifactPath": "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json",
                        "policyUpdate": positive_policy_update(
                            "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
                        ),
                    }
                ),
                encoding="utf-8",
            )
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            with self.assertRaisesRegex(runner.BatchRunError, "policy update artifact was not collected"):
                controller.verify_remote_training_report()

    def test_verified_remote_policy_update_rejects_contradictory_duplicate_metadata(self) -> None:
        artifact_path = "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        cases = (
            (
                {
                    "policyUpdateIterations": 5,
                    "policyUpdateArtifactPath": artifact_path,
                    "policyUpdate": positive_policy_update(artifact_path),
                },
                "policyUpdate.iterations disagrees",
            ),
            (
                {
                    "policyUpdateIterations": 1,
                    "policyUpdateArtifactPath": artifact_path,
                    "policyUpdate": {
                        **positive_policy_update(artifact_path),
                        "artifactPath": "runtime-artifacts/rl-training/policy-candidates/other-next-policy.json",
                    },
                },
                "policyUpdate.artifactPath disagrees",
            ),
        )
        for data, expected_error in cases:
            with self.subTest(expected_error=expected_error), tempfile.TemporaryDirectory() as temp_dir:
                with self.assertRaisesRegex(runner.BatchRunError, expected_error):
                    runner.verified_remote_policy_update_fields(
                        data,
                        top_level_safety,
                        Path(temp_dir),
                        runtime_parameter_injection=ready_runtime_parameter_injection(),
                    )

    def test_verify_remote_training_report_records_safety_flags_in_summary(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            policy_artifact_path = "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
            policy_update = positive_policy_update(policy_artifact_path)
            report.write_text(
                json.dumps(
                    {
                        "reportId": "run-test",
                        "generatedAt": "2026-05-19T12:38:23Z",
                        "experimentCard": {"codeCommit": "a" * 40},
                        "activationProof": {
                            "status": "passed",
                            "ok": True,
                            "audit": {
                                "comparisonKey": "activation-key",
                                "codeCommit": "a" * 40,
                            },
                        },
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": False,
                        "artifactCount": 1,
                        "runtimeParameterInjection": {
                            "type": "screeps-rl-runtime-parameter-injection",
                            "status": "injected",
                            "runtimeParameterInjection": True,
                            "runtimeParameterConsumption": True,
                            "runtimeParameterConsumptionStatus": "consumed",
                            "policyUpdateEligible": True,
                            "candidateParameterScope": "runtime_injected",
                            "injectedVariantCount": 1,
                            "consumedVariantCount": 1,
                            "liveEffect": False,
                            "officialMmoWrites": False,
                            "officialMmoWritesAllowed": False,
                        },
                        "scorecardId": "rl-scorecard-run-test",
                        "scorecardArtifactPath": READY_RUNTIME_SCORECARD_PATH,
                        "candidateScorecard": {
                            "status": "ready",
                            "classification": "runtime_injected_candidate_scorecard_ready",
                            "scorecardId": "rl-scorecard-run-test",
                            "runtimeParameterInjection": True,
                            "injectedVariantCount": 1,
                            "validationScaleComputeBlocked": False,
                            "scorecardUsable": True,
                        },
                        "policyUpdateIterations": 1,
                        "policyUpdateArtifactPath": policy_artifact_path,
                        "policyUpdate": policy_update,
                    }
                ),
                encoding="utf-8",
            )
            write_policy_update_artifact(root, policy_artifact_path, policy_update["updatedParameters"])
            write_ready_runtime_scorecard_artifact(root)
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)
            controller.verify_remote_training_report()
            controller.write_summary()

            summary = json.loads((root / "controller-summary.json").read_text(encoding="utf-8"))
            self.assertEqual(
                summary["safety"],
                {
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                    "billingGuardBeforeScale": True,
                    "scaleDownAttempted": False,
                    "sshControllerOnlyExpected": CONTROLLER_IP,
                    "secretsPrinted": False,
                },
            )
            self.assertEqual(summary["outputs"]["trainingReport"]["policyUpdateIterations"], 1)
            self.assertEqual(summary["outputs"]["trainingReport"]["generatedAt"], "2026-05-19T12:38:23Z")
            self.assertEqual(summary["outputs"]["trainingReport"]["experimentCard"]["codeCommit"], "a" * 40)
            self.assertEqual(
                summary["outputs"]["trainingReport"]["activationProof"]["audit"]["comparisonKey"],
                "activation-key",
            )
            self.assertTrue(
                summary["outputs"]["trainingReport"]["runtimeParameterInjection"]["runtimeParameterInjection"]
            )
            self.assertEqual(summary["outputs"]["trainingReport"]["runtimeParameterInjection"]["injectedVariantCount"], 1)
            self.assertEqual(summary["outputs"]["trainingReport"]["scorecardId"], "rl-scorecard-run-test")
            self.assertEqual(summary["outputs"]["trainingReport"]["candidateScorecard"]["status"], "ready")
            self.assertFalse(
                summary["outputs"]["trainingReport"]["candidateScorecard"]["validationScaleComputeBlocked"]
            )
            self.assertEqual(
                summary["outputs"]["trainingReport"]["policyUpdateArtifactPath"],
                "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json",
            )
            self.assertFalse(summary["outputs"]["trainingReport"]["policyUpdate"]["liveEffect"])
            self.assertEqual(summary["outputs"]["trainingReport"]["batchScale"]["batchClass"], "smoke")
            self.assertFalse(summary["outputs"]["trainingReport"]["batchScale"]["scaleFirstEligible"])
            self.assertEqual(summary["batchScale"]["batchClass"], "smoke")

    def test_verify_remote_training_report_rejects_orphaned_scorecard_evidence(self) -> None:
        cases = (
            (
                {"scorecardId": "rl-scorecard-run-test"},
                "scorecardId is present without candidateScorecard evidence",
            ),
            (
                {"scorecardArtifactPath": READY_RUNTIME_SCORECARD_PATH},
                "scorecardArtifactPath is present without candidateScorecard evidence",
            ),
        )
        for patch, expected_error in cases:
            with self.subTest(expected_error=expected_error), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                data = {
                    "reportId": "run-test",
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                    "artifactCount": 1,
                    **patch,
                }
                report = runner.remote_training_report_path(root, "run-test")
                report.parent.mkdir(parents=True, exist_ok=True)
                report.write_text(json.dumps(data), encoding="utf-8")
                controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

                with self.assertRaisesRegex(runner.BatchRunError, expected_error):
                    controller.verify_remote_training_report()

    def test_verify_remote_training_report_rejects_ready_scorecard_without_collected_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps(training_report_with_ready_runtime_scorecard()), encoding="utf-8")
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            with self.assertRaisesRegex(
                runner.BatchRunError,
                "candidate scorecard artifact was not collected",
            ):
                controller.verify_remote_training_report()

    def test_verify_remote_training_report_accepts_gradient_untrusted_materialized_scorecard(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            policy_artifact_path = "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
            gate = high_variance_consumed_promotion_gate()
            gradient_estimation = {
                "type": "screeps-rl-gradient-estimation-evidence",
                "schemaVersion": 1,
                "estimator": "scalar_weighted_sum_score_function_reinforce_v1",
                "gradientReward": "scalar_weighted_sum",
                "lexicographicRankingPreserved": True,
                "scalarWeightedSumAuthorized": False,
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            }
            gradient_momentum = {
                "type": "screeps-rl-gradient-momentum-evidence",
                "schemaVersion": 1,
                "emaDecay": 0.8,
                "momentumConsistent": True,
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            }
            policy_update = positive_policy_update(policy_artifact_path)
            policy_update.update(
                {
                    "gradientStable": False,
                    "trustedGradientUpdate": False,
                    "highVariance": True,
                    "gradientEstimation": copy.deepcopy(gradient_estimation),
                    "gradientMomentum": copy.deepcopy(gradient_momentum),
                    "gradientStability": copy.deepcopy(gate["gradientStability"]),
                    "promotionGate": copy.deepcopy(gate),
                }
            )
            next_candidate = policy_update["nextCandidatePolicy"]
            assert isinstance(next_candidate, dict)
            next_candidate.update(
                {
                    "gradientStable": False,
                    "trustedGradientUpdate": False,
                    "highVariance": True,
                    "gradientEstimation": copy.deepcopy(gradient_estimation),
                    "gradientMomentum": copy.deepcopy(gradient_momentum),
                    "gradientStability": copy.deepcopy(gate["gradientStability"]),
                    "promotionGate": copy.deepcopy(gate),
                }
            )
            data = training_report_with_ready_runtime_scorecard()
            data.update(
                {
                    "generatedAt": "2026-05-21T22:35:00Z",
                    "policyUpdateIterations": 1,
                    "policyUpdateArtifactPath": policy_artifact_path,
                    "policyUpdate": policy_update,
                    "gradientStable": False,
                    "trustedGradientUpdate": False,
                    "highVariance": True,
                    "gradientEstimation": copy.deepcopy(gradient_estimation),
                    "gradientMomentum": copy.deepcopy(gradient_momentum),
                    "gradientStability": copy.deepcopy(gate["gradientStability"]),
                    "candidateScorecard": {
                        "status": "materialized",
                        "classification": "gradient_stability_untrusted_scorecard_materialized",
                        "scorecardId": "rl-scorecard-run-test",
                        "runtimeParameterInjection": True,
                        "injectedVariantCount": 1,
                        "validationScaleComputeBlocked": True,
                        "scorecardUsable": True,
                        "missingPrerequisite": "gradient_stability",
                        "gradientStable": False,
                        "trustedGradientUpdate": False,
                        "highVariance": True,
                    },
                }
            )
            report.write_text(json.dumps(data), encoding="utf-8")
            write_policy_update_artifact(root, policy_artifact_path, policy_update["updatedParameters"], gate)
            write_ready_runtime_scorecard_artifact(root)
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)
            controller.verify_remote_training_report()

        training_report = controller.result["trainingReport"]
        self.assertEqual(training_report["candidateScorecard"]["status"], "materialized")
        self.assertEqual(
            training_report["candidateScorecard"]["classification"],
            "gradient_stability_untrusted_scorecard_materialized",
        )
        self.assertFalse(training_report["trustedGradientUpdate"])
        self.assertTrue(training_report["highVariance"])
        self.assertEqual(training_report["gradientEstimation"]["estimator"], gradient_estimation["estimator"])
        self.assertEqual(training_report["gradientMomentum"]["type"], gradient_momentum["type"])

    def test_verify_remote_training_report_accepts_gradient_materialized_scorecard_with_partial_runtime_evidence(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data = training_report_with_ready_runtime_scorecard()
            data["runtimeParameterInjection"] = {
                "status": "partial",
                "runtimeParameterInjection": False,
                "policyUpdateEligible": False,
                "candidateParameterScope": "partial_runtime_injection",
                "injectedVariantCount": 1,
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
                "variants": [
                    {"variantId": "candidate", "runtimeParameterInjection": True},
                    {"variantId": "loser", "runtimeParameterInjection": False},
                ],
            }
            data["candidateScorecard"] = {
                "status": "materialized",
                "classification": "gradient_stability_untrusted_scorecard_materialized",
                "scorecardId": "rl-scorecard-run-test",
                "runtimeParameterInjection": True,
                "injectedVariantCount": 1,
                "candidateParameterScope": "runtime_injected",
                "reportRuntimeParameterInjection": False,
                "reportInjectedVariantCount": 1,
                "validationScaleComputeBlocked": True,
                "scorecardUsable": True,
                "missingPrerequisite": "gradient_stability",
                "gradientStable": False,
                "trustedGradientUpdate": False,
                "highVariance": True,
            }
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps(data), encoding="utf-8")
            write_ready_runtime_scorecard_artifact(root)
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            controller.verify_remote_training_report()

        training_report = controller.result["trainingReport"]
        self.assertEqual(training_report["runtimeParameterInjection"]["status"], "partial")
        self.assertFalse(training_report["runtimeParameterInjection"]["runtimeParameterInjection"])
        self.assertEqual(training_report["runtimeParameterInjection"]["injectedVariantCount"], 1)
        self.assertEqual(training_report["candidateScorecard"]["status"], "materialized")
        self.assertEqual(
            training_report["candidateScorecard"]["classification"],
            "gradient_stability_untrusted_scorecard_materialized",
        )
        self.assertTrue(training_report["candidateScorecard"]["runtimeParameterInjection"])
        self.assertEqual(training_report["candidateScorecard"]["injectedVariantCount"], 1)
        self.assertTrue(training_report["candidateScorecard"]["validationScaleComputeBlocked"])

    def test_verify_remote_training_report_rejects_gradient_materialized_scorecard_mismatched_classification(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data = training_report_with_ready_runtime_scorecard()
            data["candidateScorecard"] = {
                "status": "materialized",
                "classification": "runtime_parameter_injection_metadata_only_scorecard_materialized",
                "scorecardId": "rl-scorecard-run-test",
                "runtimeParameterInjection": True,
                "injectedVariantCount": 1,
                "candidateParameterScope": "runtime_injected",
                "validationScaleComputeBlocked": True,
                "scorecardUsable": True,
                "missingPrerequisite": "gradient_stability",
                "gradientStable": False,
                "trustedGradientUpdate": False,
                "highVariance": True,
            }
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps(data), encoding="utf-8")
            write_ready_runtime_scorecard_artifact(root)
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            with self.assertRaisesRegex(
                runner.BatchRunError,
                "gradient-stability materialized status has mismatched classification",
            ):
                controller.verify_remote_training_report()

    def test_verify_remote_training_report_accepts_ready_scorecard_with_candidate_scoped_partial_runtime_evidence(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data = training_report_with_ready_runtime_scorecard()
            data["runtimeParameterInjection"] = {
                "status": "partial",
                "runtimeParameterInjection": False,
                "policyUpdateEligible": False,
                "candidateParameterScope": "partial_runtime_injection",
                "injectedVariantCount": 1,
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
                "variants": [
                    {"variantId": "candidate", "runtimeParameterInjection": True},
                    {"variantId": "loser", "runtimeParameterInjection": False},
                ],
            }
            data["candidateScorecard"] = {
                "status": "ready",
                "classification": "runtime_injected_candidate_scorecard_ready",
                "scorecardId": "rl-scorecard-run-test",
                "runtimeParameterInjection": True,
                "injectedVariantCount": 1,
                "candidateParameterScope": "runtime_injected",
                "reportRuntimeParameterInjection": False,
                "reportInjectedVariantCount": 1,
                "validationScaleComputeBlocked": False,
                "scorecardUsable": True,
            }
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps(data), encoding="utf-8")
            write_ready_runtime_scorecard_artifact(root)
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            controller.verify_remote_training_report()

        training_report = controller.result["trainingReport"]
        self.assertEqual(training_report["runtimeParameterInjection"]["status"], "partial")
        self.assertFalse(training_report["runtimeParameterInjection"]["runtimeParameterInjection"])
        self.assertEqual(training_report["candidateScorecard"]["status"], "ready")
        self.assertTrue(training_report["candidateScorecard"]["runtimeParameterInjection"])
        self.assertFalse(training_report["candidateScorecard"]["validationScaleComputeBlocked"])

    def test_verify_remote_training_report_aggregates_partial_runtime_injection_from_variant_results(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data = training_report_with_ready_runtime_scorecard()
            data["runtimeParameterInjection"] = {
                "status": "partial",
                "runtimeParameterInjection": False,
                "policyUpdateEligible": False,
                "candidateParameterScope": "partial_runtime_injection",
                "injectedVariantCount": 0,
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
                "variants": [
                    {"variantId": "candidate", "runtimeParameterInjection": False},
                ],
            }
            data["variantResults"] = [
                {
                    "variantId": "candidate",
                    "runtimeParameterInjection": {
                        "status": "partial",
                        "runtimeParameterInjection": False,
                        "candidateParameterScope": "partial_runtime_injection",
                        "attempts": [
                            {
                                "status": "missing_runtime_parameter_consumption",
                                "runtimeParameterInjection": True,
                            }
                        ],
                    },
                }
            ]
            data["candidateScorecard"] = {
                "status": "ready",
                "classification": "runtime_injected_candidate_scorecard_ready",
                "scorecardId": "rl-scorecard-run-test",
                "runtimeParameterInjection": True,
                "injectedVariantCount": 1,
                "candidateParameterScope": "runtime_injected",
                "reportRuntimeParameterInjection": False,
                "reportInjectedVariantCount": 1,
                "validationScaleComputeBlocked": False,
                "scorecardUsable": True,
            }
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps(data), encoding="utf-8")
            write_ready_runtime_scorecard_artifact(root)
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            controller.verify_remote_training_report()

        training_report = controller.result["trainingReport"]
        self.assertEqual(training_report["runtimeParameterInjection"]["status"], "partial")
        self.assertFalse(training_report["runtimeParameterInjection"]["runtimeParameterInjection"])
        self.assertEqual(training_report["runtimeParameterInjection"]["injectedVariantCount"], 1)
        self.assertEqual(training_report["candidateScorecard"]["status"], "ready")
        self.assertTrue(training_report["candidateScorecard"]["runtimeParameterInjection"])

    def test_verify_remote_training_report_accepts_valid_candidate_scorecard_set(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data = training_report_with_ready_runtime_scorecard()
            data["candidateScorecards"] = ready_runtime_candidate_scorecard_set()
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps(data), encoding="utf-8")
            write_ready_runtime_scorecard_artifact(root)
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            controller.verify_remote_training_report()

        scorecard_set = controller.result["trainingReport"]["candidateScorecards"]
        self.assertEqual(scorecard_set["type"], runner.MULTI_CANDIDATE_SCORECARD_SET_TYPE)
        self.assertEqual(scorecard_set["status"], "ready")
        self.assertEqual(scorecard_set["comparisonCount"], 1)
        self.assertEqual(scorecard_set["comparisons"][0]["scorecardId"], "rl-scorecard-run-test")

    def test_verify_remote_training_report_accepts_complete_candidate_scorecard_matrix(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data = training_report_with_ready_runtime_scorecard()
            scorecard_matrix = ready_runtime_candidate_scorecard_matrix()
            data["candidateScorecards"] = scorecard_matrix
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps(data), encoding="utf-8")
            write_ready_runtime_scorecard_artifact(root)
            write_candidate_scorecard_set_artifacts(root, scorecard_matrix)
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            controller.verify_remote_training_report()

        scorecard_set = controller.result["trainingReport"]["candidateScorecards"]
        comparisons = scorecard_set["comparisons"]
        self.assertEqual(scorecard_set["comparisonCount"], 4)
        scorecard_ids = [item["scorecardId"] for item in comparisons]
        artifact_paths = [item["scorecardArtifactPath"] for item in comparisons]
        self.assertEqual(len(scorecard_ids), len(set(scorecard_ids)))
        self.assertEqual(len(artifact_paths), len(set(artifact_paths)))
        for item in comparisons:
            self.assertIn(item["scorecardId"], item["scorecardArtifactPath"])
        self.assertEqual(
            {
                (item["candidateStrategyId"], item["baselineStrategyId"])
                for item in comparisons
            },
            {
                ("candidate-a", "baseline-a"),
                ("candidate-a", "baseline-b"),
                ("candidate-b", "baseline-a"),
                ("candidate-b", "baseline-b"),
            },
        )

    def test_verify_remote_training_report_rejects_malformed_candidate_scorecard_set(self) -> None:
        duplicate_matrix = ready_runtime_candidate_scorecard_matrix()
        duplicate_matrix["comparisons"][-1] = copy.deepcopy(duplicate_matrix["comparisons"][0])
        missing_matrix = ready_runtime_candidate_scorecard_matrix()
        missing_matrix["comparisons"] = missing_matrix["comparisons"][:-1]
        missing_matrix["comparisonCount"] = len(missing_matrix["comparisons"])
        missing_matrix["materializedScorecardCount"] = len(missing_matrix["comparisons"])
        missing_matrix["readyComparisonCount"] = len(missing_matrix["comparisons"])
        cases = (
            (
                "non-object set",
                ["not-a-scorecard-set"],
                "candidateScorecards must be an object",
            ),
            (
                "non-list comparisons",
                {**ready_runtime_candidate_scorecard_set(), "comparisons": {"bad": True}},
                "candidateScorecards.comparisons must be a list",
            ),
            (
                "malformed comparison",
                {
                    **ready_runtime_candidate_scorecard_set(),
                    "comparisons": ["not-a-scorecard"],
                },
                "candidateScorecards.comparisons\\[0\\] must be an object",
            ),
            (
                "comparison count mismatch",
                {**ready_runtime_candidate_scorecard_set(), "comparisonCount": 2},
                "candidateScorecards.comparisonCount disagrees with comparisons",
            ),
            (
                "duplicate comparison pair",
                duplicate_matrix,
                "candidateScorecards.comparisons\\[3\\] duplicates comparison",
            ),
            (
                "missing comparison pair",
                missing_matrix,
                "candidateScorecards.comparisons does not cover the full candidate/baseline matrix",
            ),
        )
        for name, scorecard_set, expected_error in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                data = training_report_with_ready_runtime_scorecard()
                data["candidateScorecards"] = scorecard_set
                report = runner.remote_training_report_path(root, "run-test")
                report.parent.mkdir(parents=True, exist_ok=True)
                report.write_text(json.dumps(data), encoding="utf-8")
                write_ready_runtime_scorecard_artifact(root)
                write_candidate_scorecard_set_artifacts(root, scorecard_set)
                controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

                with self.assertRaisesRegex(runner.BatchRunError, expected_error):
                    controller.verify_remote_training_report()

    def test_verify_remote_training_report_accepts_materialized_metadata_only_scorecard(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data = training_report_with_ready_runtime_scorecard()
            data["runtimeParameterInjection"] = {
                "status": "metadata_only",
                "runtimeParameterInjection": False,
                "policyUpdateEligible": False,
                "candidateParameterScope": "metadata_only",
                "injectedVariantCount": 0,
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            }
            data["candidateScorecard"] = {
                "status": "materialized",
                "classification": "runtime_parameter_injection_metadata_only_scorecard_materialized",
                "scorecardId": "rl-scorecard-run-test",
                "runtimeParameterInjection": False,
                "injectedVariantCount": 0,
                "candidateParameterScope": "metadata_only",
                "missingPrerequisite": "runtime_parameter_injection",
                "validationScaleComputeBlocked": True,
                "scorecardUsable": True,
            }
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps(data), encoding="utf-8")
            write_ready_runtime_scorecard_artifact(root)
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            controller.verify_remote_training_report()

        training_report = controller.result["trainingReport"]
        self.assertEqual(training_report["scorecardId"], "rl-scorecard-run-test")
        self.assertEqual(training_report["candidateScorecard"]["status"], "materialized")
        self.assertTrue(training_report["candidateScorecard"]["validationScaleComputeBlocked"])
        self.assertTrue(training_report["candidateScorecard"]["scorecardUsable"])
        self.assertFalse(training_report["candidateScorecard"]["runtimeParameterInjection"])

    def test_verify_remote_training_report_accepts_runtime_blocked_materialized_scorecard_with_gradient_metadata(
        self,
    ) -> None:
        cases = (
            (
                "runtime injection metadata only",
                {
                    "status": "metadata_only",
                    "runtimeParameterInjection": False,
                    "policyUpdateEligible": False,
                    "candidateParameterScope": "metadata_only",
                    "injectedVariantCount": 0,
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                },
                {
                    "classification": "runtime_parameter_injection_metadata_only_scorecard_materialized",
                    "candidateParameterScope": "metadata_only",
                    "missingPrerequisite": "runtime_parameter_injection",
                },
            ),
            (
                "runtime consumption missing",
                {
                    "status": "not_injected",
                    "runtimeParameterInjection": False,
                    "runtimeParameterConsumption": False,
                    "runtimeParameterConsumptionStatus": "missing_runtime_parameter_consumption",
                    "policyUpdateEligible": False,
                    "candidateParameterScope": "runtime_injected",
                    "injectedVariantCount": 0,
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                },
                {
                    "classification": "runtime_parameter_consumption_missing_scorecard_materialized",
                    "candidateParameterScope": "runtime_injected",
                    "missingPrerequisite": "runtime_parameter_consumption",
                },
            ),
        )
        for name, runtime_parameter_injection, candidate_patch in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                data = training_report_with_ready_runtime_scorecard()
                data["runtimeParameterInjection"] = runtime_parameter_injection
                data["candidateScorecard"] = {
                    "status": "materialized",
                    "scorecardId": "rl-scorecard-run-test",
                    "runtimeParameterInjection": False,
                    "injectedVariantCount": 0,
                    "validationScaleComputeBlocked": True,
                    "scorecardUsable": True,
                    "gradientStable": False,
                    "trustedGradientUpdate": False,
                    "highVariance": True,
                    **candidate_patch,
                }
                report = runner.remote_training_report_path(root, "run-test")
                report.parent.mkdir(parents=True, exist_ok=True)
                report.write_text(json.dumps(data), encoding="utf-8")
                write_ready_runtime_scorecard_artifact(root)
                controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

                controller.verify_remote_training_report()

                training_report = controller.result["trainingReport"]
                self.assertEqual(
                    training_report["candidateScorecard"]["missingPrerequisite"],
                    candidate_patch["missingPrerequisite"],
                )
                self.assertFalse(training_report["candidateScorecard"]["runtimeParameterInjection"])
                self.assertFalse(training_report["candidateScorecard"]["trustedGradientUpdate"])
                self.assertTrue(training_report["candidateScorecard"]["highVariance"])

    def test_verify_remote_training_report_preserves_non_consumed_materialized_scorecard(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data = training_report_with_ready_runtime_scorecard()
            data["runtimeParameterInjection"] = {
                "status": "injected",
                "runtimeParameterInjection": True,
                "runtimeParameterConsumption": False,
                "runtimeParameterConsumptionStatus": "missing_runtime_parameter_consumption",
                "policyUpdateEligible": False,
                "candidateParameterScope": "runtime_injected",
                "injectedVariantCount": 5,
                "consumedVariantCount": 0,
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            }
            held_scorecard = {
                "status": "materialized",
                "classification": "runtime_parameter_consumption_missing_scorecard_materialized",
                "scorecardId": "rl-scorecard-run-test",
                "scorecardArtifactPath": READY_RUNTIME_SCORECARD_PATH,
                "candidateStrategyId": "candidate",
                "baselineStrategyId": "baseline",
                "candidateRank": 1,
                "baselineRank": 2,
                "comparisonKey": "candidate::vs::baseline",
                "runtimeParameterInjection": True,
                "runtimeParameterConsumption": False,
                "injectedVariantCount": 1,
                "consumedVariantCount": 0,
                "candidateParameterScope": "runtime_injected",
                "reportRuntimeParameterInjection": True,
                "reportRuntimeParameterConsumption": False,
                "reportInjectedVariantCount": 5,
                "reportConsumedVariantCount": 0,
                "missingPrerequisite": "runtime_parameter_consumption",
                "validationScaleComputeBlocked": True,
                "scorecardUsable": True,
                "overallGate": {
                    "status": "HOLD",
                    "runtimeParameterInjectionProven": False,
                },
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            }
            data["candidateScorecard"] = copy.deepcopy(held_scorecard)
            data["candidateScorecards"] = {
                "type": runner.MULTI_CANDIDATE_SCORECARD_SET_TYPE,
                "schemaVersion": 1,
                "status": "materialized",
                "classification": "multi_candidate_scorecards_materialized",
                "reportId": "run-test",
                "comparisonCount": 1,
                "candidateCount": 1,
                "baselineCount": 1,
                "candidateStrategyIds": ["candidate"],
                "baselineStrategyIds": ["baseline"],
                "selectedScorecardId": "rl-scorecard-run-test",
                "materializedScorecardCount": 1,
                "blockedComparisonCount": 0,
                "readyComparisonCount": 0,
                "validationScaleComputeBlocked": True,
                "scorecardUsable": True,
                "missingPrerequisites": ["runtime_parameter_consumption"],
                "reasonCodes": ["runtime_parameter_consumption_missing_scorecard_materialized"],
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
                "comparisons": [copy.deepcopy(held_scorecard)],
            }
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps(data), encoding="utf-8")
            write_ready_runtime_scorecard_artifact(root)
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            controller.verify_remote_training_report()

        training_report = controller.result["trainingReport"]
        scorecard = training_report["candidateScorecard"]
        self.assertEqual(scorecard["status"], "materialized")
        self.assertEqual(
            scorecard["classification"],
            "runtime_parameter_consumption_missing_scorecard_materialized",
        )
        self.assertTrue(scorecard["runtimeParameterInjection"])
        self.assertFalse(scorecard["runtimeParameterConsumption"])
        self.assertEqual(scorecard["missingPrerequisite"], "runtime_parameter_consumption")
        self.assertEqual(scorecard["overallGate"]["status"], "HOLD")
        self.assertEqual(training_report["candidateScorecards"]["status"], "materialized")

    def test_verify_remote_training_report_preserves_metadata_only_zero_count_runtime_injection_gap(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data = training_report_with_ready_runtime_scorecard()
            data["runtimeParameterInjection"] = {
                "status": "metadata_only",
                "runtimeParameterInjection": False,
                "runtimeParameterConsumption": False,
                "runtimeParameterConsumptionStatus": "missing_runtime_parameter_consumption",
                "policyUpdateEligible": False,
                "candidateParameterScope": "metadata_only",
                "injectedVariantCount": 0,
                "consumedVariantCount": 0,
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            }
            data["candidateScorecard"] = {
                "status": "materialized",
                "classification": "runtime_parameter_injection_metadata_only_scorecard_materialized",
                "scorecardId": "rl-scorecard-run-test",
                "runtimeParameterInjection": False,
                "runtimeParameterConsumption": False,
                "injectedVariantCount": 0,
                "consumedVariantCount": 0,
                "candidateParameterScope": "metadata_only",
                "missingPrerequisite": "runtime_parameter_injection",
                "validationScaleComputeBlocked": True,
                "scorecardUsable": True,
            }
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps(data), encoding="utf-8")
            write_ready_runtime_scorecard_artifact(root)
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            controller.verify_remote_training_report()

        runtime_parameter_injection = controller.result["trainingReport"]["runtimeParameterInjection"]
        self.assertEqual(runtime_parameter_injection["status"], "metadata_only")
        self.assertFalse(runtime_parameter_injection["runtimeParameterConsumption"])
        self.assertEqual(runtime_parameter_injection["injectedVariantCount"], 0)
        self.assertEqual(
            controller.result["trainingReport"]["candidateScorecard"]["missingPrerequisite"],
            "runtime_parameter_injection",
        )

    def test_verify_remote_training_report_rejects_gradient_materialized_scorecard_without_runtime_proof(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data = training_report_with_ready_runtime_scorecard()
            data["runtimeParameterInjection"] = {
                "status": "metadata_only",
                "runtimeParameterInjection": False,
                "policyUpdateEligible": False,
                "candidateParameterScope": "metadata_only",
                "injectedVariantCount": 0,
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            }
            data["candidateScorecard"] = {
                "status": "materialized",
                "classification": "gradient_stability_untrusted_scorecard_materialized",
                "scorecardId": "rl-scorecard-run-test",
                "runtimeParameterInjection": False,
                "injectedVariantCount": 0,
                "candidateParameterScope": "metadata_only",
                "missingPrerequisite": "gradient_stability",
                "validationScaleComputeBlocked": True,
                "scorecardUsable": True,
                "gradientStable": False,
                "trustedGradientUpdate": False,
                "highVariance": True,
            }
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps(data), encoding="utf-8")
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            with self.assertRaisesRegex(
                runner.BatchRunError,
                "gradient-stability materialized status requires runtimeParameterInjection proof",
            ):
                controller.verify_remote_training_report()

    def test_verify_remote_training_report_rejects_unsafe_gradient_materialized_partial_runtime_evidence(
        self,
    ) -> None:
        cases = (
            (
                "missing candidate runtime proof",
                {"runtimeParameterInjection": False, "injectedVariantCount": 1},
                "gradient-stability materialized status requires runtimeParameterInjection proof",
            ),
            (
                "candidate count exceeds report partial count",
                {"runtimeParameterInjection": True, "injectedVariantCount": 2},
                "gradient-stability materialized status exceeds top-level runtimeParameterInjection injectedVariantCount",
            ),
        )
        for name, candidate_patch, expected_error in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                data = training_report_with_ready_runtime_scorecard()
                data["runtimeParameterInjection"] = {
                    "status": "partial",
                    "runtimeParameterInjection": False,
                    "policyUpdateEligible": False,
                    "candidateParameterScope": "partial_runtime_injection",
                    "injectedVariantCount": 1,
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                }
                data["candidateScorecard"] = {
                    "status": "materialized",
                    "classification": "gradient_stability_untrusted_scorecard_materialized",
                    "scorecardId": "rl-scorecard-run-test",
                    "candidateParameterScope": "runtime_injected",
                    "reportRuntimeParameterInjection": False,
                    "reportInjectedVariantCount": 1,
                    "missingPrerequisite": "gradient_stability",
                    "validationScaleComputeBlocked": True,
                    "scorecardUsable": True,
                    "gradientStable": False,
                    "trustedGradientUpdate": False,
                    "highVariance": True,
                    **candidate_patch,
                }
                report = runner.remote_training_report_path(root, "run-test")
                report.parent.mkdir(parents=True, exist_ok=True)
                report.write_text(json.dumps(data), encoding="utf-8")
                controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

                with self.assertRaisesRegex(runner.BatchRunError, expected_error):
                    controller.verify_remote_training_report()

    def test_verify_remote_training_report_rejects_materialized_scorecard_with_injected_count(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data = training_report_with_ready_runtime_scorecard()
            data["runtimeParameterInjection"] = {
                "status": "metadata_only",
                "runtimeParameterInjection": False,
                "policyUpdateEligible": False,
                "candidateParameterScope": "metadata_only",
                "injectedVariantCount": 0,
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            }
            data["candidateScorecard"] = {
                "status": "materialized",
                "classification": "runtime_parameter_injection_metadata_only_scorecard_materialized",
                "scorecardId": "rl-scorecard-run-test",
                "runtimeParameterInjection": False,
                "injectedVariantCount": 1,
                "candidateParameterScope": "metadata_only",
                "missingPrerequisite": "runtime_parameter_injection",
                "validationScaleComputeBlocked": True,
                "scorecardUsable": True,
            }
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps(data), encoding="utf-8")
            write_ready_runtime_scorecard_artifact(root)
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            with self.assertRaisesRegex(
                runner.BatchRunError,
                "materialized status requires injectedVariantCount=0",
            ):
                controller.verify_remote_training_report()

    def test_verify_remote_training_report_rejects_malformed_runtime_parameter_injection_evidence(self) -> None:
        def injection_patch(
            *,
            status: str,
            runtime_parameter_injection: bool,
            policy_update_eligible: bool,
            candidate_parameter_scope: str,
            injected_variant_count: int,
        ) -> dict[str, object]:
            return {
                "runtimeParameterInjection": {
                    "status": status,
                    "runtimeParameterInjection": runtime_parameter_injection,
                    "policyUpdateEligible": policy_update_eligible,
                    "candidateParameterScope": candidate_parameter_scope,
                    "injectedVariantCount": injected_variant_count,
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                }
            }

        cases = (
            ("string evidence", {"runtimeParameterInjection": "false"}, "runtimeParameterInjection must be an object"),
            (
                "missing eligibility",
                {
                    "runtimeParameterInjection": {
                        "status": "injected",
                        "runtimeParameterInjection": True,
                        "candidateParameterScope": "runtime_injected",
                        "injectedVariantCount": 1,
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": False,
                    }
                },
                "policyUpdateEligible",
            ),
            (
                "string boolean",
                {
                    "runtimeParameterInjection": {
                        "status": "injected",
                        "runtimeParameterInjection": "true",
                        "policyUpdateEligible": True,
                        "candidateParameterScope": "runtime_injected",
                        "injectedVariantCount": 1,
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": False,
                    }
                },
                "runtimeParameterInjection.runtimeParameterInjection must be a boolean",
            ),
            (
                "eligible missing consumption proof",
                injection_patch(
                    status="injected",
                    runtime_parameter_injection=True,
                    policy_update_eligible=True,
                    candidate_parameter_scope="runtime_injected",
                    injected_variant_count=1,
                ),
                "policyUpdateEligible requires runtimeParameterConsumption=true",
            ),
            (
                "consumed proof missing consumed count",
                {
                    "runtimeParameterInjection": {
                        "status": "injected",
                        "runtimeParameterInjection": True,
                        "runtimeParameterConsumption": True,
                        "runtimeParameterConsumptionStatus": "consumed",
                        "policyUpdateEligible": True,
                        "candidateParameterScope": "runtime_injected",
                        "injectedVariantCount": 1,
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": False,
                    }
                },
                "consumedVariantCount must be positive when consumption is proven",
            ),
            (
                "unknown false status",
                injection_patch(
                    status="garbage",
                    runtime_parameter_injection=False,
                    policy_update_eligible=False,
                    candidate_parameter_scope="metadata_only",
                    injected_variant_count=0,
                ),
                "runtimeParameterInjection.status invalid",
            ),
            (
                "metadata scope mismatch",
                injection_patch(
                    status="metadata_only",
                    runtime_parameter_injection=False,
                    policy_update_eligible=False,
                    candidate_parameter_scope="runtime_injected",
                    injected_variant_count=0,
                ),
                "metadata_only status requires metadata_only scope",
            ),
            (
                "not injected scope mismatch",
                injection_patch(
                    status="not_injected",
                    runtime_parameter_injection=False,
                    policy_update_eligible=False,
                    candidate_parameter_scope="metadata_only",
                    injected_variant_count=0,
                ),
                "not_injected status requires runtime_injected scope",
            ),
            (
                "metadata positive injected count",
                injection_patch(
                    status="metadata_only",
                    runtime_parameter_injection=False,
                    policy_update_eligible=False,
                    candidate_parameter_scope="metadata_only",
                    injected_variant_count=1,
                ),
                "metadata_only status requires injectedVariantCount=0",
            ),
            (
                "partial zero injected count",
                injection_patch(
                    status="partial",
                    runtime_parameter_injection=False,
                    policy_update_eligible=False,
                    candidate_parameter_scope="partial_runtime_injection",
                    injected_variant_count=0,
                ),
                "partial status requires positive injectedVariantCount",
            ),
            (
                "partial zero injected count with explicit consumption gap",
                {
                    "runtimeParameterInjection": {
                        "status": "partial",
                        "runtimeParameterInjection": False,
                        "runtimeParameterConsumption": False,
                        "runtimeParameterConsumptionStatus": "missing_runtime_parameter_consumption",
                        "policyUpdateEligible": False,
                        "candidateParameterScope": "partial_runtime_injection",
                        "injectedVariantCount": 0,
                        "consumedVariantCount": 0,
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": False,
                    }
                },
                "partial status requires positive injectedVariantCount",
            ),
        )
        for name, patch, expected_error in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                data = training_report_with_ready_runtime_scorecard()
                data.update(patch)
                report = runner.remote_training_report_path(root, "run-test")
                report.parent.mkdir(parents=True, exist_ok=True)
                report.write_text(json.dumps(data), encoding="utf-8")
                controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

                with self.assertRaisesRegex(runner.BatchRunError, expected_error):
                    controller.verify_remote_training_report()

    def test_verify_remote_training_report_accepts_materialization_failure_with_runtime_injection_proof(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data = training_report_with_ready_runtime_scorecard()
            data["scorecardId"] = None
            data["scorecardArtifactPath"] = None
            data["candidateScorecard"] = {
                "status": "blocked",
                "classification": "candidate_scorecard_materialization_failed",
                "scorecardId": None,
                "runtimeParameterInjection": True,
                "injectedVariantCount": 1,
                "candidateParameterScope": "runtime_injected",
                "candidateStrategyId": "candidate",
                "baselineStrategyId": "baseline",
                "candidateRank": 1,
                "baselineRank": 2,
                "missingPrerequisite": "candidate_scorecard_artifact",
                "validationScaleComputeBlocked": True,
                "scorecardUsable": False,
            }
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps(data), encoding="utf-8")
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            controller.verify_remote_training_report()

        verified = controller.result["trainingReport"]["candidateScorecard"]
        self.assertEqual(verified["classification"], "candidate_scorecard_materialization_failed")
        self.assertTrue(verified["runtimeParameterInjection"])
        self.assertEqual(verified["candidateParameterScope"], "runtime_injected")
        self.assertEqual(verified["candidateStrategyId"], "candidate")

    def test_verify_remote_training_report_accepts_materialization_failure_without_runtime_injection_proof(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data = training_report_with_ready_runtime_scorecard()
            data["runtimeParameterInjection"] = {
                "status": "metadata_only",
                "runtimeParameterInjection": False,
                "policyUpdateEligible": False,
                "candidateParameterScope": "metadata_only",
                "injectedVariantCount": 0,
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            }
            data["scorecardId"] = None
            data["scorecardArtifactPath"] = None
            data["candidateScorecard"] = {
                "status": "blocked",
                "classification": "candidate_scorecard_materialization_failed",
                "scorecardId": None,
                "runtimeParameterInjection": False,
                "injectedVariantCount": 0,
                "candidateParameterScope": "metadata_only",
                "candidateStrategyId": "candidate",
                "baselineStrategyId": "baseline",
                "candidateRank": 1,
                "baselineRank": 2,
                "missingPrerequisite": "candidate_scorecard_artifact",
                "validationScaleComputeBlocked": True,
                "scorecardUsable": False,
            }
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps(data), encoding="utf-8")
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            controller.verify_remote_training_report()

        verified = controller.result["trainingReport"]["candidateScorecard"]
        self.assertEqual(verified["classification"], "candidate_scorecard_materialization_failed")
        self.assertFalse(verified["runtimeParameterInjection"])
        self.assertEqual(verified["candidateParameterScope"], "metadata_only")

    def test_verify_remote_training_report_accepts_blocked_partial_runtime_injection_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data = training_report_with_ready_runtime_scorecard()
            data["runtimeParameterInjection"] = {
                "status": "partial",
                "runtimeParameterInjection": False,
                "policyUpdateEligible": False,
                "candidateParameterScope": "partial_runtime_injection",
                "injectedVariantCount": 1,
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            }
            data["scorecardId"] = None
            data["scorecardArtifactPath"] = None
            data["candidateScorecard"] = {
                "status": "blocked",
                "classification": "runtime_parameter_injection_validation_blocked",
                "scorecardId": None,
                "runtimeParameterInjection": False,
                "injectedVariantCount": 1,
                "validationScaleComputeBlocked": True,
                "scorecardUsable": False,
            }
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps(data), encoding="utf-8")
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            controller.verify_remote_training_report()

        training_report = controller.result["trainingReport"]
        self.assertEqual(training_report["runtimeParameterInjection"]["status"], "partial")
        self.assertEqual(training_report["runtimeParameterInjection"]["injectedVariantCount"], 1)
        self.assertEqual(training_report["candidateScorecard"]["status"], "blocked")
        self.assertFalse(training_report["candidateScorecard"]["runtimeParameterInjection"])
        self.assertEqual(training_report["candidateScorecard"]["injectedVariantCount"], 1)
        self.assertTrue(training_report["candidateScorecard"]["validationScaleComputeBlocked"])
        self.assertFalse(training_report["candidateScorecard"]["scorecardUsable"])
        self.assertIsNone(training_report["scorecardId"])
        self.assertIsNone(training_report["scorecardArtifactPath"])

    def test_verify_remote_training_report_rejects_inconsistent_candidate_scorecard_evidence(self) -> None:
        cases = (
            (
                "string evidence",
                {"candidateScorecard": "ready"},
                "candidateScorecard must be an object",
            ),
            (
                "ready blocked",
                {
                    "candidateScorecard": {
                        "status": "ready",
                        "scorecardId": "rl-scorecard-run-test",
                        "runtimeParameterInjection": True,
                        "injectedVariantCount": 1,
                        "validationScaleComputeBlocked": True,
                        "scorecardUsable": True,
                    }
                },
                "ready status cannot be validation-scale blocked",
            ),
            (
                "ready without runtime proof",
                {
                    "runtimeParameterInjection": {
                        "status": "metadata_only",
                        "runtimeParameterInjection": False,
                        "policyUpdateEligible": False,
                        "candidateParameterScope": "metadata_only",
                        "injectedVariantCount": 0,
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": False,
                    },
                },
                "ready without runtimeParameterInjection proof",
            ),
            (
                "blocked contradicts top-level runtime proof",
                {
                    "scorecardId": None,
                    "scorecardArtifactPath": None,
                    "candidateScorecard": {
                        "status": "blocked",
                        "classification": "runtime_parameter_injection_validation_blocked",
                        "scorecardId": None,
                        "runtimeParameterInjection": False,
                        "injectedVariantCount": 0,
                        "validationScaleComputeBlocked": True,
                        "scorecardUsable": False,
                    },
                },
                "blocked status contradicts top-level runtimeParameterInjection proof",
            ),
            (
                "blocked without materialization failure has injected count",
                {
                    "runtimeParameterInjection": {
                        "status": "metadata_only",
                        "runtimeParameterInjection": False,
                        "policyUpdateEligible": False,
                        "candidateParameterScope": "metadata_only",
                        "injectedVariantCount": 0,
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": False,
                    },
                    "scorecardId": None,
                    "scorecardArtifactPath": None,
                    "candidateScorecard": {
                        "status": "blocked",
                        "classification": "runtime_parameter_injection_metadata_only",
                        "scorecardId": None,
                        "runtimeParameterInjection": False,
                        "injectedVariantCount": 1,
                        "validationScaleComputeBlocked": True,
                        "scorecardUsable": False,
                    },
                },
                "blocked status requires injectedVariantCount=0",
            ),
        )
        for name, patch, expected_error in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                data = training_report_with_ready_runtime_scorecard()
                data.update(patch)
                report = runner.remote_training_report_path(root, "run-test")
                report.parent.mkdir(parents=True, exist_ok=True)
                report.write_text(json.dumps(data), encoding="utf-8")
                controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

                with self.assertRaisesRegex(runner.BatchRunError, expected_error):
                    controller.verify_remote_training_report()

    def test_verify_remote_training_report_records_smoke_batch_scale_from_simulator_ticks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(
                json.dumps(
                    {
                        "reportId": "run-test",
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": False,
                        "artifactCount": 5,
                        "simulation": {"ticks": 500},
                        "variantResults": [
                            {"variantId": f"variant-{index}", "runs": [{"ticksRun": 500, "ok": True}]}
                            for index in range(5)
                        ],
                    }
                ),
                encoding="utf-8",
            )
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)
            controller.verify_remote_training_report()
            controller.write_summary()

            summary = json.loads((root / "controller-summary.json").read_text(encoding="utf-8"))

        batch_scale = summary["outputs"]["trainingReport"]["batchScale"]
        self.assertEqual(batch_scale["batchClass"], "smoke")
        self.assertEqual(batch_scale["environmentRows"], 5)
        self.assertEqual(batch_scale["simulatorTicks"], 2500)
        self.assertFalse(batch_scale["scaleFirstEligible"])
        self.assertEqual(summary["batchScale"]["batchClass"], "smoke")
        self.assertEqual(summary["batchScale"]["basis"], "training_report")

    def test_controller_run_accepts_metadata_only_zero_iteration_update_and_preserves_completed_evidence(self) -> None:
        policy_update = {
            "type": "screeps-rl-policy-update",
            "schemaVersion": 1,
            "iterations": 0,
            "algorithm": "true_gradient_reinforce_v1",
            "targetFamily": "multi-tier-territory-combat",
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
            "safety": {
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            },
            "skippedReason": "candidate_parameters_metadata_only",
            "candidateCount": 0,
            "metadataCandidateCount": 5,
            "parameterEvidence": {
                "candidateParameterScope": "metadata_only",
                "runtimeParameterInjection": False,
                "policyUpdateEligible": False,
                "reason": "candidate vectors were metadata only",
            },
        }

        class FakeController(runner.Controller):
            def check_pre_launch_guard(self) -> bool:
                return False

            def ensure_map_present(self) -> None:
                pass

            def ensure_dist_present(self) -> None:
                pass

            def run_billing_guard(self) -> None:
                pass

            def verify_security_group(self) -> None:
                pass

            def generate_experiment_card(self) -> None:
                pass

            def scale_up_and_wait(self) -> None:
                self.scaled_up = True
                self.instance_id = "ins-test"

            def verify_worker_security(self) -> None:
                pass

            def bootstrap_worker(self) -> None:
                pass

            def transfer_repo_bundle(self) -> None:
                pass

            def transfer_secret_env(self) -> None:
                pass

            def run_remote_training(self) -> None:
                self.record_step("remote_training", 100.0, True, reportId=self.run_id)

            def collect_remote_artifacts(self) -> None:
                report = runner.remote_training_report_path(self.artifact_dir, self.run_id)
                report.parent.mkdir(parents=True, exist_ok=True)
                report.write_text(
                    json.dumps(
                        {
                            "reportId": self.run_id,
                            "generatedAt": "2026-05-20T03:51:09Z",
                            "liveEffect": False,
                            "officialMmoWrites": False,
                            "officialMmoWritesAllowed": False,
                            "artifactCount": 25,
                            "simulation": {"ticks": runner.POLICY_GRADIENT_MIN_SIMULATION_TICKS},
                            "scaleValidation": {
                                "ok": True,
                                "targetEnvironments": 5,
                                "minimumSuccessfulEnvironments": 20,
                                "totalEnvironments": 25,
                                "successfulEnvironments": 25,
                                "repetitions": 5,
                            },
                            "runtimeParameterInjection": {
                                "type": "screeps-rl-runtime-parameter-injection",
                                "status": "metadata_only",
                                "runtimeParameterInjection": False,
                                "policyUpdateEligible": False,
                                "candidateParameterScope": "metadata_only",
                                "injectedVariantCount": 0,
                                "reason": "candidate vectors were metadata only",
                                "liveEffect": False,
                                "officialMmoWrites": False,
                                "officialMmoWritesAllowed": False,
                            },
                            "scorecardId": "rl-scorecard-run-test",
                            "scorecardArtifactPath": READY_RUNTIME_SCORECARD_PATH,
                            "candidateScorecard": {
                                "status": "materialized",
                                "classification": "runtime_parameter_injection_metadata_only_scorecard_materialized",
                                "scorecardId": "rl-scorecard-run-test",
                                "runtimeParameterInjection": False,
                                "injectedVariantCount": 0,
                                "candidateParameterScope": "metadata_only",
                                "missingPrerequisite": "runtime_parameter_injection",
                                "validationScaleComputeBlocked": True,
                                "scorecardUsable": True,
                            },
                            "policyUpdateIterations": 0,
                            "policyUpdate": policy_update,
                        }
                    ),
                    encoding="utf-8",
                )
                write_ready_runtime_scorecard_artifact(self.artifact_dir)

            def scale_down(self) -> None:
                self.record_step("scale_down", 101.0, True, desiredCapacity=0)

        args = controller_args()
        args.training_approach = "policy_gradient"
        args.scenario_id = runner.MULTI_TIER_SCENARIO_ID
        args.ticks = 500
        args.workers = 5
        args.repetitions = 5
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            args.artifact_root = artifact_root
            controller = FakeController(
                args=args,
                run_id="tencent-pg-metadata-only",
                artifact_dir=artifact_root / "tencent-pg-metadata-only",
            )
            with mock.patch.object(runner, "validate_static_inputs", return_value=None):
                controller.run()
            summary = json.loads(
                (artifact_root / "tencent-pg-metadata-only" / "controller-summary.json").read_text(
                    encoding="utf-8",
                )
            )

        training_report = summary["outputs"]["trainingReport"]
        self.assertEqual(summary["finalStatus"], "completed")
        self.assertEqual(summary["execution"]["artifactCount"], 25)
        self.assertEqual(summary["execution"]["environmentsRun"], 25)
        self.assertEqual(summary["batchScale"]["environmentRows"], 25)
        self.assertEqual(
            summary["batchScale"]["simulatorTicks"],
            25 * runner.POLICY_GRADIENT_MIN_SIMULATION_TICKS,
        )
        self.assertEqual(training_report["artifactCount"], 25)
        self.assertEqual(training_report["policyUpdateIterations"], 0)
        self.assertIsNone(training_report["policyUpdateArtifactPath"])
        self.assertFalse(training_report["runtimeParameterInjection"]["runtimeParameterInjection"])
        self.assertEqual(training_report["runtimeParameterInjection"]["injectedVariantCount"], 0)
        self.assertEqual(training_report["scorecardId"], "rl-scorecard-run-test")
        self.assertEqual(training_report["candidateScorecard"]["status"], "materialized")
        self.assertTrue(training_report["candidateScorecard"]["validationScaleComputeBlocked"])
        self.assertTrue(training_report["candidateScorecard"]["scorecardUsable"])
        self.assertEqual(training_report["policyUpdate"]["metadataCandidateCount"], 5)
        self.assertFalse(training_report["policyUpdate"]["parameterEvidence"]["policyUpdateEligible"])
        self.assertNotIn("nextCandidatePolicy", training_report["policyUpdate"])

    def test_e1s1_repeat_launch_guard_blocks_after_three_dead_tier_runs(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for run_id in ("tencent-pg-1", "tencent-pg-2", "tencent-pg-3"):
                write_tencent_guard_summary(artifact_root, run_id)
            args = controller_args()
            args.artifact_root = artifact_root
            args.training_approach = "policy_gradient"
            args.ticks = 500
            args.explicit_cli_options = {"scenario_id"}

            guard = runner.build_e1s1_repeat_launch_guard(
                args=args,
                run_id="new-run",
                artifact_dir=artifact_root / "new-run",
            )

        self.assertTrue(guard["blocked"])
        self.assertEqual(guard["status"], "blocked")
        self.assertEqual(guard["evidence"]["count"], 3)
        self.assertIn("multi-tier", guard["nextAction"])
        self.assertFalse(guard["safety"]["scaleOutAttempted"])
        self.assertEqual({item["territory"] for item in guard["evidence"]["runs"]}, {2})
        self.assertEqual({item["kills"] for item in guard["evidence"]["runs"]}, {0})

    def test_e1s1_repeat_launch_guard_ignores_legacy_500_tick_policy_gradient_smokes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for run_id in ("tencent-pg-legacy-1", "tencent-pg-legacy-2", "tencent-pg-legacy-3"):
                write_tencent_guard_summary(artifact_root, run_id, ticks=500)
            args = controller_args()
            args.artifact_root = artifact_root
            args.training_approach = "policy_gradient"
            args.ticks = 500
            args.explicit_cli_options = {"scenario_id"}

            guard = runner.build_e1s1_repeat_launch_guard(
                args=args,
                run_id="new-run",
                artifact_dir=artifact_root / "new-run",
            )

        self.assertFalse(guard["blocked"])
        self.assertEqual(guard["status"], "clear")
        self.assertEqual(guard["evidence"]["count"], 0)
        self.assertEqual(guard["currentLaunch"]["effectiveTicks"], runner.POLICY_GRADIENT_MIN_SIMULATION_TICKS)

    def test_e1s1_repeat_launch_guard_scans_past_recent_irrelevant_summaries(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            valid_paths = [
                write_tencent_guard_summary(artifact_root, f"tencent-pg-valid-{index}") for index in range(3)
            ]
            noisy_paths = [
                write_tencent_guard_summary(artifact_root, f"tencent-pg-preflight-{index}", final_status="preflight_ok")
                for index in range(runner.E1S1_REPEAT_GUARD_RECENT_SUMMARY_LIMIT)
            ]
            for index, summary_path in enumerate(valid_paths):
                timestamp = 1_700_000_000 + index
                os.utime(summary_path, (timestamp, timestamp))
            for index, summary_path in enumerate(noisy_paths):
                timestamp = 1_700_000_100 + index
                os.utime(summary_path, (timestamp, timestamp))
            args = controller_args()
            args.artifact_root = artifact_root
            args.training_approach = "policy_gradient"
            args.ticks = 500
            args.explicit_cli_options = {"scenario_id"}

            guard = runner.build_e1s1_repeat_launch_guard(
                args=args,
                run_id="new-run",
                artifact_dir=artifact_root / "new-run",
            )

        self.assertTrue(guard["blocked"])
        self.assertEqual(guard["evidence"]["count"], 3)
        self.assertEqual(
            {item["runId"] for item in guard["evidence"]["runs"]},
            {"tencent-pg-valid-0", "tencent-pg-valid-1", "tencent-pg-valid-2"},
        )

    def test_e1s1_repeat_launch_guard_requires_explicit_room_and_map_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for run_id in ("tencent-pg-1", "tencent-pg-2", "tencent-pg-3"):
                strip_tencent_guard_location_evidence(write_tencent_guard_summary(artifact_root, run_id))
            args = controller_args()
            args.artifact_root = artifact_root
            args.training_approach = "policy_gradient"
            args.ticks = 500
            args.explicit_cli_options = {"scenario_id"}

            guard = runner.build_e1s1_repeat_launch_guard(
                args=args,
                run_id="new-run",
                artifact_dir=artifact_root / "new-run",
            )

        self.assertFalse(guard["blocked"])
        self.assertEqual(guard["status"], "clear")
        self.assertEqual(guard["evidence"]["count"], 0)

    def test_e1s1_repeat_launch_guard_allows_insufficient_dead_tier_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            write_tencent_guard_summary(artifact_root, "tencent-pg-1")
            write_tencent_guard_summary(artifact_root, "tencent-pg-2")
            write_tencent_guard_summary(
                artifact_root,
                "tencent-pg-with-kills",
                territory_kills=((2, 0), (2, 1)),
            )
            args = controller_args()
            args.artifact_root = artifact_root
            args.training_approach = "policy_gradient"
            args.ticks = 500
            args.explicit_cli_options = {"scenario_id"}

            guard = runner.build_e1s1_repeat_launch_guard(
                args=args,
                run_id="new-run",
                artifact_dir=artifact_root / "new-run",
            )

        self.assertFalse(guard["blocked"])
        self.assertEqual(guard["status"], "clear")
        self.assertEqual(guard["evidence"]["count"], 2)
        self.assertIsNone(guard["nextAction"])

    def test_e1s1_repeat_launch_guard_allows_non_e1s1_launch(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for run_id in ("tencent-pg-1", "tencent-pg-2", "tencent-pg-3"):
                write_tencent_guard_summary(artifact_root, run_id)
            args = controller_args()
            args.artifact_root = artifact_root
            args.scenario_id = runner.MULTI_TIER_SCENARIO_ID
            args.require_multi_tier_scenario = True
            args.training_approach = "policy_gradient"
            args.ticks = 500

            guard = runner.build_e1s1_repeat_launch_guard(
                args=args,
                run_id="new-run",
                artifact_dir=artifact_root / "new-run",
            )

        self.assertFalse(guard["blocked"])
        self.assertEqual(guard["currentLaunch"]["scenarioId"], runner.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(guard["currentLaunch"]["requireMultiTierScenario"])
        self.assertEqual(guard["currentLaunch"]["mapSourceFile"], runner.MULTI_TIER_SIMULATION_MAP_SOURCE_REL)
        self.assertEqual(guard["currentLaunch"]["fixtureEvidence"]["adjacentRoom"], "E2S1")
        self.assertEqual(guard["currentLaunch"]["fixtureEvidence"]["neutralExpansionRoomCount"], 2)
        self.assertEqual(guard["currentLaunch"]["fixtureEvidence"]["hostileCreepCount"], 3)
        self.assertEqual(guard["currentLaunch"]["fixtureEvidence"]["hostileSpawnCount"], 1)
        self.assertEqual(guard["currentLaunch"]["fixtureEvidence"]["hostileTowerCount"], 1)
        self.assertEqual(guard["evidence"]["count"], 0)

    def test_paid_failure_recurrence_guard_extracts_room_busy_signature_from_summary_text(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            summary_path = write_tencent_failure_summary(
                artifact_root,
                "tencent-pg-room-busy",
                failure_class=None,
                failure_text=(
                    "pre-scale private-simulator trainability smoke gate failed: "
                    "place-spawn room busy after 12 attempt(s): "
                    '{"classification": "place_spawn_room_busy"}'
                ),
            )
            summary = json.loads(summary_path.read_text(encoding="utf-8"))

            evidence = runner.paid_failure_recurrence_evidence_from_summary(summary, summary_path)

        assert evidence is not None
        self.assertEqual(evidence["signature"], runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE)
        self.assertEqual(evidence["reason"], "place-spawn room busy")
        self.assertEqual(evidence["matchedBy"], "controller-summary diagnostic text")
        self.assertIn("place-spawn room busy after 12 attempt", evidence["diagnosticExcerpt"])

    def test_paid_failure_recurrence_guard_ignores_nonterminal_room_busy_retry_telemetry(self) -> None:
        retry_log = "\n".join(
            [
                'phase="place-spawn room busy; retrying" attempt="1" maxAttempts="12" retrySeconds="1.0"',
                'phase="place-spawn room busy; retrying" attempt="1" maxAttempts="12" retrySeconds="1.0"',
            ]
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            summary_path = write_tencent_failure_summary(
                artifact_root,
                "postfix-room-busy-validation",
                failure_class="remote_training_timeout",
                failure_text=retry_log,
            )
            summary = json.loads(summary_path.read_text(encoding="utf-8"))

            evidence = runner.paid_failure_recurrence_evidence_from_summary(summary, summary_path)

        self.assertIsNone(evidence)

    def test_paid_failure_recurrence_guard_allows_dispatch_below_threshold(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD - 1):
                write_tencent_failure_summary(artifact_root, f"tencent-pg-room-busy-{index}")
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "1",
            ])
            artifact_dir = artifact_root / "new-run"

            events, controller, guard, summary = self.run_stubbed_compute(args, artifact_dir)

        self.assertFalse(guard["blocked"])
        self.assertEqual(guard["checks"]["paidFailureRecurrence"]["status"], "clear")
        self.assertEqual(
            guard["checks"]["paidFailureRecurrence"]["evidence"]["count"],
            runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD - 1,
        )
        self.assertEqual(controller.final_status, "completed")
        self.assertEqual(summary["finalStatus"], "completed")
        self.assertIn("scale_up", events)
        self.assertTrue(summary["execution"]["scaleOutAttempted"])

    def test_paid_failure_recurrence_guard_blocks_room_busy_threshold_before_compute(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD):
                write_tencent_failure_summary(artifact_root, f"tencent-pg-room-busy-{index}")
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "1",
            ])
            artifact_dir = artifact_root / "new-run"

            with mock.patch.object(
                runner,
                "paid_failure_recurrence_known_fix_status",
                return_value={
                    "signature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                    "issue": "#1501",
                    "pullRequest": "#1504",
                    "mergeCommit": "95f960b2",
                    "present": False,
                    "evidence": "merge commit 95f960b2 is not reachable from HEAD",
                },
            ):
                events, controller, guard, summary = self.run_stubbed_compute(args, artifact_dir)

        self.assertEqual(events, [])
        self.assertTrue(guard["blocked"])
        self.assertEqual(guard["activeGuard"], "paid_failure_recurrence_guard")
        self.assertEqual(guard["status"], "blocked")
        self.assertEqual(guard["evidence"]["activeSignature"], runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE)
        self.assertEqual(guard["evidence"]["count"], runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD)
        self.assertIn("#1506", guard["nextAction"])
        self.assertIn("#1501", guard["nextAction"])
        self.assertIn("#1504", guard["nextAction"])
        self.assertIn("simulator_place_spawn_room_busy", guard["reason"])
        self.assertEqual(controller.final_status, runner.PAID_FAILURE_RECURRENCE_GUARD_FINAL_STATUS)
        self.assertEqual(summary["finalStatus"], runner.PAID_FAILURE_RECURRENCE_GUARD_FINAL_STATUS)
        self.assertEqual(summary["outputs"]["launchGuard"]["activeSignature"], runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE)
        self.assertFalse(summary["execution"]["computeAttempted"])
        self.assertFalse(summary["execution"]["scaleOutAttempted"])
        self.assertFalse(summary["safety"]["scaleDownAttempted"])

    def test_paid_failure_recurrence_guard_gives_post_fix_validation_action_when_fix_present(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD):
                write_tencent_failure_summary(artifact_root, f"tencent-pg-room-busy-{index}")
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "1",
            ])
            artifact_dir = artifact_root / "new-run"

            with mock.patch.object(
                runner,
                "paid_failure_recurrence_known_fix_status",
                return_value={
                    "signature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                    "issue": "#1501",
                    "pullRequest": "#1504",
                    "mergeCommit": "95f960b2",
                    "present": True,
                    "evidence": "merge commit 95f960b2 is reachable from HEAD",
                },
            ):
                events, controller, guard, summary = self.run_stubbed_compute(args, artifact_dir)

        self.assertEqual(events, [])
        self.assertEqual(controller.final_status, runner.PAID_FAILURE_RECURRENCE_GUARD_FINAL_STATUS)
        self.assertTrue(guard["blocked"])
        self.assertEqual(guard["status"], runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_REQUIRED_STATUS)
        self.assertEqual(guard["postFixValidation"]["status"], "available")
        self.assertTrue(guard["postFixValidation"]["knownFix"]["present"])
        self.assertIn("--allow-paid-failure-recurrence-validation", guard["nextAction"])
        self.assertIn(runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE, guard["nextAction"])
        self.assertNotIn("ship and verify", guard["nextAction"])
        self.assertEqual(
            summary["outputs"]["launchGuard"]["postFixValidation"]["status"],
            "available",
        )
        self.assertFalse(summary["execution"]["computeAttempted"])

    def test_paid_failure_recurrence_guard_allows_explicit_post_fix_validation_once(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD):
                write_tencent_failure_summary(artifact_root, f"tencent-pg-room-busy-{index}")
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "1",
                "--allow-paid-failure-recurrence-validation",
                runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
            ])
            artifact_dir = artifact_root / "new-run"

            with mock.patch.object(
                runner,
                "paid_failure_recurrence_known_fix_status",
                return_value={
                    "signature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                    "issue": "#1501",
                    "pullRequest": "#1504",
                    "mergeCommit": "95f960b2",
                    "present": True,
                    "evidence": "merge commit 95f960b2 is reachable from HEAD",
                },
            ):
                events, controller, guard, summary = self.run_stubbed_compute(args, artifact_dir)

        self.assertIn("scale_up", events)
        self.assertIn("remote_training", events)
        self.assertFalse(guard["blocked"])
        self.assertIsNone(guard["activeGuard"])
        self.assertEqual(guard["status"], runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_ALLOWED_STATUS)
        self.assertEqual(guard["postFixValidation"]["status"], "allowed")
        self.assertTrue(guard["postFixValidation"]["requested"])
        self.assertIn("exactly one", guard["nextAction"])
        self.assertEqual(controller.final_status, "completed")
        self.assertEqual(summary["finalStatus"], "completed")
        self.assertTrue(summary["execution"]["computeAttempted"])
        self.assertEqual(
            summary["outputs"]["launchGuard"]["postFixValidation"]["status"],
            "allowed",
        )

    def test_paid_failure_recurrence_guard_blocks_second_post_fix_validation_attempt(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD):
                write_tencent_failure_summary(artifact_root, f"tencent-pg-room-busy-{index}")
            write_post_fix_validation_summary(
                artifact_root,
                "tencent-pg-post-fix-failed",
                final_status="failed",
                failure_class=runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
            )
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "1",
                "--allow-paid-failure-recurrence-validation",
                runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
            ])
            artifact_dir = artifact_root / "new-run"

            with mock.patch.object(
                runner,
                "paid_failure_recurrence_known_fix_status",
                return_value={
                    "signature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                    "issue": "#1501",
                    "pullRequest": "#1504",
                    "mergeCommit": "95f960b2",
                    "present": True,
                    "evidence": "merge commit 95f960b2 is reachable from HEAD",
                },
            ):
                events, controller, guard, summary = self.run_stubbed_compute(args, artifact_dir)

        self.assertEqual(events, [])
        self.assertEqual(controller.final_status, runner.PAID_FAILURE_RECURRENCE_GUARD_FINAL_STATUS)
        self.assertTrue(guard["blocked"])
        self.assertEqual(guard["status"], runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_CONSUMED_STATUS)
        self.assertEqual(guard["postFixValidation"]["status"], "consumed")
        self.assertEqual(guard["postFixValidation"]["priorAttempt"]["runId"], "tencent-pg-post-fix-failed")
        self.assertFalse(guard["postFixValidation"]["recoveryEligibility"]["eligible"])
        self.assertIn("reached compute", guard["postFixValidation"]["recoveryEligibility"]["reason"])
        self.assertIn("already attempted", guard["nextAction"])
        self.assertFalse(summary["execution"]["computeAttempted"])

    def test_paid_failure_recurrence_guard_blocks_second_post_fix_validation_while_prior_unknown(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD):
                write_tencent_failure_summary(artifact_root, f"tencent-pg-room-busy-{index}")
            write_post_fix_validation_in_progress_summary(
                artifact_root,
                "tencent-pg-post-fix-running",
            )
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "1",
                "--allow-paid-failure-recurrence-validation",
                runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
            ])
            artifact_dir = artifact_root / "new-run"

            with mock.patch.object(
                runner,
                "paid_failure_recurrence_known_fix_status",
                return_value={
                    "signature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                    "issue": "#1501",
                    "pullRequest": "#1504",
                    "mergeCommit": "95f960b2",
                    "present": True,
                    "evidence": "merge commit 95f960b2 is reachable from HEAD",
                },
            ):
                events, controller, guard, summary = self.run_stubbed_compute(args, artifact_dir)

        self.assertEqual(events, [])
        self.assertEqual(controller.final_status, runner.PAID_FAILURE_RECURRENCE_GUARD_FINAL_STATUS)
        self.assertTrue(guard["blocked"])
        self.assertEqual(guard["status"], runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_CONSUMED_STATUS)
        self.assertEqual(guard["postFixValidation"]["status"], "consumed")
        prior_attempt = guard["postFixValidation"]["priorAttempt"]
        self.assertEqual(prior_attempt["runId"], "tencent-pg-post-fix-running")
        self.assertEqual(prior_attempt["finalStatus"], "unknown")
        self.assertTrue(prior_attempt["validationSlotConsumed"])
        self.assertFalse(guard["postFixValidation"]["recoveryEligibility"]["eligible"])
        self.assertIn(
            "not a pre-scale no-compute admission failure",
            guard["postFixValidation"]["recoveryEligibility"]["reason"],
        )
        self.assertFalse(summary["execution"]["computeAttempted"])

    def test_paid_failure_recurrence_guard_allows_recovery_after_pre_scale_admission_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD):
                write_tencent_failure_summary(artifact_root, f"tencent-pg-room-busy-{index}")
            write_post_fix_validation_pre_scale_admission_failure_summary(
                artifact_root,
                "tencent-postfix-room-busy-v1",
            )
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "5",
                "--scale-environments",
                "5",
                "--repetitions",
                "5",
                "--allow-paid-failure-recurrence-validation",
                runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
            ])
            artifact_dir = artifact_root / "new-run"

            with mock.patch.object(
                runner,
                "paid_failure_recurrence_known_fix_status",
                return_value={
                    "signature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                    "issue": "#1501",
                    "pullRequest": "#1504",
                    "mergeCommit": "95f960b2",
                    "present": True,
                    "evidence": "merge commit 95f960b2 is reachable from HEAD",
                },
            ):
                events, controller, guard, summary = self.run_stubbed_compute(args, artifact_dir)

        self.assertIn("scale_up", events)
        self.assertIn("remote_training", events)
        self.assertFalse(guard["blocked"])
        self.assertEqual(guard["status"], runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_RECOVERY_ALLOWED_STATUS)
        self.assertEqual(guard["postFixValidation"]["status"], "recovery_allowed")
        self.assertTrue(guard["postFixValidation"]["recoveryEligibility"]["eligible"])
        self.assertEqual(
            guard["postFixValidation"]["priorAttempt"]["runId"],
            "tencent-postfix-room-busy-v1",
        )
        self.assertTrue(guard["postFixValidation"]["priorAttempt"]["executionContextPresent"])
        self.assertFalse(guard["postFixValidation"]["priorAttempt"]["computeAttempted"])
        self.assertFalse(guard["postFixValidation"]["priorAttempt"]["scaleOutAttempted"])
        self.assertFalse(guard["postFixValidation"]["priorAttempt"]["remoteTrainingAttempted"])
        self.assertFalse(guard["postFixValidation"]["priorAttempt"]["trainingReportProduced"])
        self.assertEqual(guard["postFixValidation"]["priorAttempt"]["environmentsRun"], 0)
        self.assertEqual(
            guard["currentLaunch"]["policyGradientTrustSampleRequest"]["requestedSamplesPerCandidate"],
            25,
        )
        self.assertTrue(guard["currentLaunch"]["policyGradientTrustSampleRequest"]["meetsTrustSampleTarget"])
        self.assertEqual(controller.final_status, "completed")
        self.assertEqual(summary["outputs"]["launchGuard"]["status"], runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_RECOVERY_ALLOWED_STATUS)
        self.assertEqual(summary["outputs"]["launchGuard"]["postFixValidation"]["status"], "recovery_allowed")
        self.assertTrue(summary["execution"]["computeAttempted"])

    def test_paid_failure_recurrence_guard_allows_explicit_recovery_after_remote_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD):
                write_tencent_failure_summary(artifact_root, f"tencent-pg-room-busy-{index}")
            write_post_fix_validation_remote_timeout_summary(
                artifact_root,
                "postfix-room-busy-validation-timeout",
            )
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "5",
                "--scale-environments",
                "5",
                "--repetitions",
                "5",
                "--postfix-validation-signature",
                runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
            ])
            artifact_dir = artifact_root / "new-run"

            with mock.patch.object(
                runner,
                "paid_failure_recurrence_known_fix_status",
                return_value={
                    "signature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                    "issue": "#1501",
                    "pullRequest": "#1504",
                    "mergeCommit": "95f960b2",
                    "present": True,
                    "evidence": "merge commit 95f960b2 is reachable from HEAD",
                },
            ):
                events, controller, guard, summary = self.run_stubbed_compute(args, artifact_dir)

        self.assertIn("scale_up", events)
        self.assertIn("remote_training", events)
        self.assertFalse(guard["blocked"])
        self.assertEqual(guard["status"], runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_RECOVERY_ALLOWED_STATUS)
        recovery = guard["postFixValidation"]["recoveryEligibility"]
        self.assertTrue(recovery["eligible"])
        self.assertEqual(recovery["recoveryClass"], "remote_training_timeout")
        self.assertEqual(
            guard["postFixValidation"]["priorAttempt"]["remoteTrainingFailureClass"],
            "remote_training_timeout",
        )
        self.assertIn("explicitly sized timeout", guard["nextAction"])
        self.assertEqual(controller.final_status, "completed")
        self.assertEqual(summary["outputs"]["launchGuard"]["postFixValidation"]["status"], "recovery_allowed")

    def test_paid_failure_recurrence_guard_allows_timeout_fix_after_timed_out_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD):
                write_tencent_failure_summary(artifact_root, f"tencent-pg-room-busy-{index}")
            pre_scale_attempt_path = write_post_fix_validation_pre_scale_admission_failure_summary(
                artifact_root,
                "tencent-postfix-room-busy-v1",
            )
            timeout_attempt_path = write_post_fix_validation_recovery_remote_timeout_summary(
                artifact_root,
                "postfix-room-busy-validation-timeout",
            )
            pre_scale_attempt = json.loads(pre_scale_attempt_path.read_text(encoding="utf-8"))
            timeout_attempt = json.loads(timeout_attempt_path.read_text(encoding="utf-8"))
            self.assertGreater(timeout_attempt["finishedAt"], pre_scale_attempt["finishedAt"])
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "5",
                "--scale-environments",
                "5",
                "--repetitions",
                "5",
                "--postfix-validation-signature",
                runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
            ])
            artifact_dir = artifact_root / "new-run"

            with mock.patch.object(
                runner,
                "paid_failure_recurrence_known_fix_status",
                return_value={
                    "signature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                    "issue": "#1501",
                    "pullRequest": "#1504",
                    "mergeCommit": "95f960b2",
                    "present": True,
                    "evidence": "merge commit 95f960b2 is reachable from HEAD",
                },
            ):
                events, controller, guard, summary = self.run_stubbed_compute(args, artifact_dir)

        self.assertIn("scale_up", events)
        self.assertFalse(guard["blocked"])
        self.assertEqual(guard["status"], runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_RECOVERY_ALLOWED_STATUS)
        recovery = guard["postFixValidation"]["recoveryEligibility"]
        self.assertTrue(recovery["eligible"])
        self.assertEqual(recovery["recoveryClass"], "remote_training_timeout_after_recovery")
        self.assertEqual(recovery["priorRecoveryAttemptRunId"], "postfix-room-busy-validation-timeout")
        self.assertIn("explicitly sized timeout", guard["nextAction"])
        self.assertIn("remote-training timeout", guard["reason"])
        self.assertEqual(controller.final_status, "completed")
        self.assertEqual(summary["outputs"]["launchGuard"]["postFixValidation"]["status"], "recovery_allowed")

    def test_paid_failure_recurrence_guard_explains_timeout_recovery_when_signature_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD):
                write_tencent_failure_summary(artifact_root, f"tencent-pg-room-busy-{index}")
            write_post_fix_validation_pre_scale_admission_failure_summary(
                artifact_root,
                "tencent-postfix-room-busy-v1",
            )
            write_post_fix_validation_recovery_remote_timeout_summary(
                artifact_root,
                "postfix-room-busy-validation-timeout",
            )
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "5",
                "--scale-environments",
                "5",
                "--repetitions",
                "5",
            ])
            artifact_dir = artifact_root / "new-run"

            with mock.patch.object(
                runner,
                "paid_failure_recurrence_known_fix_status",
                return_value={
                    "signature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                    "issue": "#1501",
                    "pullRequest": "#1504",
                    "mergeCommit": "95f960b2",
                    "present": True,
                    "evidence": "merge commit 95f960b2 is reachable from HEAD",
                },
            ):
                events, controller, guard, summary = self.run_stubbed_compute(args, artifact_dir)

        self.assertEqual(events, [])
        self.assertEqual(controller.final_status, runner.PAID_FAILURE_RECURRENCE_GUARD_FINAL_STATUS)
        self.assertTrue(guard["blocked"])
        self.assertEqual(guard["status"], runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_CONSUMED_STATUS)
        recovery = guard["postFixValidation"]["recoveryEligibility"]
        self.assertFalse(recovery["eligible"])
        self.assertEqual(recovery["recoveryClass"], "remote_training_timeout_after_recovery")
        self.assertEqual(recovery["priorRecoveryAttemptRunId"], "postfix-room-busy-validation-timeout")
        self.assertIn("explicit post-fix validation signature", recovery["reason"])
        self.assertIn("explicit post-fix validation signature", guard["nextAction"])
        self.assertIn("explicitly sized timeout", guard["nextAction"])
        self.assertIn("smaller validation slice", guard["nextAction"])
        self.assertFalse(summary["execution"]["computeAttempted"])

    def test_paid_failure_recurrence_guard_ignores_preflight_only_recovery_admission(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD):
                write_tencent_failure_summary(artifact_root, f"tencent-pg-room-busy-{index}")
            write_post_fix_validation_preflight_admission_summary(
                artifact_root,
                "cron-postfix-room-busy-recovery-preflight-20260530t063756z",
            )
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "5",
                "--scale-environments",
                "5",
                "--repetitions",
                "5",
                "--allow-paid-failure-recurrence-validation",
                runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
            ])
            artifact_dir = artifact_root / "new-run"

            with mock.patch.object(
                runner,
                "paid_failure_recurrence_known_fix_status",
                return_value={
                    "signature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                    "issue": "#1501",
                    "pullRequest": "#1504",
                    "mergeCommit": "95f960b2",
                    "present": True,
                    "evidence": "merge commit 95f960b2 is reachable from HEAD",
                },
            ):
                events, controller, guard, summary = self.run_stubbed_compute(args, artifact_dir)

        self.assertIn("scale_up", events)
        self.assertIn("remote_training", events)
        self.assertFalse(guard["blocked"])
        self.assertEqual(guard["status"], runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_ALLOWED_STATUS)
        self.assertEqual(guard["postFixValidation"]["status"], "allowed")
        self.assertIsNone(guard["postFixValidation"]["priorAttempt"])
        self.assertNotIn("priorAttemptCount", guard["postFixValidation"])
        self.assertEqual(controller.final_status, "completed")
        self.assertTrue(summary["execution"]["computeAttempted"])

    def test_paid_failure_recurrence_guard_blocks_legacy_run_single_failure_without_execution_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD):
                write_tencent_failure_summary(artifact_root, f"tencent-pg-room-busy-{index}")
            prior_attempt_path = write_post_fix_validation_pre_scale_admission_failure_summary(
                artifact_root,
                "tencent-postfix-room-busy-v1",
            )
            prior_summary = json.loads(prior_attempt_path.read_text(encoding="utf-8"))
            prior_summary.pop("execution")
            prior_attempt_path.write_text(json.dumps(prior_summary), encoding="utf-8")
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "5",
                "--scale-environments",
                "5",
                "--repetitions",
                "5",
                "--allow-paid-failure-recurrence-validation",
                runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
            ])
            artifact_dir = artifact_root / "new-run"

            with mock.patch.object(
                runner,
                "paid_failure_recurrence_known_fix_status",
                return_value={
                    "signature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                    "issue": "#1501",
                    "pullRequest": "#1504",
                    "mergeCommit": "95f960b2",
                    "present": True,
                    "evidence": "merge commit 95f960b2 is reachable from HEAD",
                },
            ):
                events, controller, guard, summary = self.run_stubbed_compute(args, artifact_dir)

        self.assertEqual(events, [])
        self.assertEqual(controller.final_status, runner.PAID_FAILURE_RECURRENCE_GUARD_FINAL_STATUS)
        self.assertTrue(guard["blocked"])
        self.assertEqual(guard["status"], runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_CONSUMED_STATUS)
        self.assertEqual(guard["postFixValidation"]["status"], "consumed")
        prior_attempt = guard["postFixValidation"]["priorAttempt"]
        self.assertEqual(prior_attempt["runId"], "tencent-postfix-room-busy-v1")
        self.assertFalse(prior_attempt["executionContextPresent"])
        self.assertTrue(prior_attempt["validationSlotConsumed"])
        self.assertFalse(guard["postFixValidation"]["recoveryEligibility"]["eligible"])
        self.assertIn(
            "not a pre-scale no-compute admission failure",
            guard["postFixValidation"]["recoveryEligibility"]["reason"],
        )
        self.assertFalse(summary["execution"]["computeAttempted"])

    def test_paid_failure_recurrence_guard_blocks_recovery_with_incomplete_prior_execution_metadata(self) -> None:
        cases: list[tuple[str, str | None]] = [("empty execution", None)]
        cases.extend(
            (f"missing {field}", field)
            for field in runner.PAID_FAILURE_POST_FIX_NO_COMPUTE_REQUIRED_EXECUTION_FIELDS
        )

        for case_name, missing_field in cases:
            with self.subTest(case=case_name):
                with tempfile.TemporaryDirectory() as temp_dir:
                    artifact_root = Path(temp_dir) / "batch-runs"
                    for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD):
                        write_tencent_failure_summary(artifact_root, f"tencent-pg-room-busy-{index}")
                    prior_attempt_path = write_post_fix_validation_pre_scale_admission_failure_summary(
                        artifact_root,
                        "tencent-postfix-room-busy-v1",
                    )
                    prior_summary = json.loads(prior_attempt_path.read_text(encoding="utf-8"))
                    if missing_field is None:
                        prior_summary["execution"] = {}
                    else:
                        execution = prior_summary["execution"]
                        self.assertIsInstance(execution, dict)
                        execution.pop(missing_field, None)
                    prior_attempt_path.write_text(json.dumps(prior_summary), encoding="utf-8")
                    args = runner.parse_cli_args([
                        "run-single",
                        "--run-id",
                        "new-run",
                        "--artifact-root",
                        str(artifact_root),
                        "--training-approach",
                        "policy_gradient",
                        "--scenario-id",
                        runner.MULTI_TIER_SCENARIO_ID,
                        "--ticks",
                        "500",
                        "--workers",
                        "5",
                        "--scale-environments",
                        "5",
                        "--repetitions",
                        "5",
                        "--allow-paid-failure-recurrence-validation",
                        runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                    ])
                    artifact_dir = artifact_root / "new-run"

                    with mock.patch.object(
                        runner,
                        "paid_failure_recurrence_known_fix_status",
                        return_value={
                            "signature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                            "issue": "#1501",
                            "pullRequest": "#1504",
                            "mergeCommit": "95f960b2",
                            "present": True,
                            "evidence": "merge commit 95f960b2 is reachable from HEAD",
                        },
                    ):
                        events, controller, guard, summary = self.run_stubbed_compute(args, artifact_dir)

                self.assertEqual(events, [])
                self.assertEqual(controller.final_status, runner.PAID_FAILURE_RECURRENCE_GUARD_FINAL_STATUS)
                self.assertTrue(guard["blocked"])
                self.assertEqual(guard["status"], runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_CONSUMED_STATUS)
                self.assertNotEqual(
                    guard["status"],
                    runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_RECOVERY_ALLOWED_STATUS,
                )
                self.assertEqual(guard["postFixValidation"]["status"], "consumed")
                prior_attempt = guard["postFixValidation"]["priorAttempt"]
                self.assertEqual(prior_attempt["runId"], "tencent-postfix-room-busy-v1")
                self.assertFalse(prior_attempt["executionContextPresent"])
                self.assertTrue(prior_attempt["validationSlotConsumed"])
                self.assertFalse(guard["postFixValidation"]["recoveryEligibility"]["eligible"])
                self.assertIn(
                    "not a pre-scale no-compute admission failure",
                    guard["postFixValidation"]["recoveryEligibility"]["reason"],
                )
                self.assertFalse(summary["execution"]["computeAttempted"])

    def test_paid_failure_recurrence_guard_blocks_recovery_without_explicit_signature(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD):
                write_tencent_failure_summary(artifact_root, f"tencent-pg-room-busy-{index}")
            write_post_fix_validation_pre_scale_admission_failure_summary(
                artifact_root,
                "tencent-postfix-room-busy-v1",
            )
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "5",
                "--scale-environments",
                "5",
                "--repetitions",
                "5",
            ])
            artifact_dir = artifact_root / "new-run"

            with mock.patch.object(
                runner,
                "paid_failure_recurrence_known_fix_status",
                return_value={
                    "signature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                    "issue": "#1501",
                    "pullRequest": "#1504",
                    "mergeCommit": "95f960b2",
                    "present": True,
                    "evidence": "merge commit 95f960b2 is reachable from HEAD",
                },
            ):
                events, controller, guard, summary = self.run_stubbed_compute(args, artifact_dir)

        self.assertEqual(events, [])
        self.assertEqual(controller.final_status, runner.PAID_FAILURE_RECURRENCE_GUARD_FINAL_STATUS)
        self.assertTrue(guard["blocked"])
        self.assertEqual(guard["status"], runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_CONSUMED_STATUS)
        self.assertEqual(guard["postFixValidation"]["status"], "consumed")
        self.assertFalse(guard["postFixValidation"]["recoveryEligibility"]["eligible"])
        self.assertIn("explicit post-fix validation signature", guard["postFixValidation"]["recoveryEligibility"]["reason"])
        self.assertFalse(summary["execution"]["computeAttempted"])

    def test_paid_failure_recurrence_guard_blocks_recovery_below_trust_sample_target(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD):
                write_tencent_failure_summary(artifact_root, f"tencent-pg-room-busy-{index}")
            write_post_fix_validation_pre_scale_admission_failure_summary(
                artifact_root,
                "tencent-postfix-room-busy-v1",
            )
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "1",
                "--repetitions",
                "1",
                "--allow-paid-failure-recurrence-validation",
                runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
            ])
            artifact_dir = artifact_root / "new-run"

            with mock.patch.object(
                runner,
                "paid_failure_recurrence_known_fix_status",
                return_value={
                    "signature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                    "issue": "#1501",
                    "pullRequest": "#1504",
                    "mergeCommit": "95f960b2",
                    "present": True,
                    "evidence": "merge commit 95f960b2 is reachable from HEAD",
                },
            ):
                events, controller, guard, summary = self.run_stubbed_compute(args, artifact_dir)

        self.assertEqual(events, [])
        self.assertEqual(controller.final_status, runner.PAID_FAILURE_RECURRENCE_GUARD_FINAL_STATUS)
        self.assertTrue(guard["blocked"])
        self.assertEqual(guard["status"], runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_CONSUMED_STATUS)
        self.assertEqual(guard["postFixValidation"]["status"], "consumed")
        self.assertFalse(guard["postFixValidation"]["recoveryEligibility"]["eligible"])
        self.assertIn("below the trust gate target", guard["postFixValidation"]["recoveryEligibility"]["reason"])
        self.assertEqual(
            guard["postFixValidation"]["recoveryEligibility"]["policyGradientTrustSampleRequest"][
                "requestedSamplesPerCandidate"
            ],
            1,
        )
        self.assertFalse(summary["execution"]["computeAttempted"])

    def test_paid_failure_recurrence_guard_blocks_second_recovery_attempt(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD):
                write_tencent_failure_summary(artifact_root, f"tencent-pg-room-busy-{index}")
            prior_attempt_path = write_post_fix_validation_summary(
                artifact_root,
                "tencent-postfix-room-busy-recovery",
                final_status="failed",
                failure_class=runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
            )
            prior_summary = json.loads(prior_attempt_path.read_text(encoding="utf-8"))
            prior_launch_guard = prior_summary["outputs"]["launchGuard"]
            prior_launch_guard["status"] = runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_RECOVERY_ALLOWED_STATUS
            prior_launch_guard["postFixValidation"]["status"] = "recovery_allowed"
            prior_attempt_path.write_text(json.dumps(prior_summary), encoding="utf-8")
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "5",
                "--scale-environments",
                "5",
                "--repetitions",
                "5",
                "--allow-paid-failure-recurrence-validation",
                runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
            ])
            artifact_dir = artifact_root / "new-run"

            with mock.patch.object(
                runner,
                "paid_failure_recurrence_known_fix_status",
                return_value={
                    "signature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                    "issue": "#1501",
                    "pullRequest": "#1504",
                    "mergeCommit": "95f960b2",
                    "present": True,
                    "evidence": "merge commit 95f960b2 is reachable from HEAD",
                },
            ):
                events, controller, guard, summary = self.run_stubbed_compute(args, artifact_dir)

        self.assertEqual(events, [])
        self.assertEqual(controller.final_status, runner.PAID_FAILURE_RECURRENCE_GUARD_FINAL_STATUS)
        self.assertTrue(guard["blocked"])
        self.assertEqual(guard["status"], runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_CONSUMED_STATUS)
        self.assertEqual(guard["postFixValidation"]["status"], "consumed")
        self.assertTrue(guard["postFixValidation"]["priorAttempt"]["recoveryAttempt"])
        self.assertTrue(guard["postFixValidation"]["priorAttempt"]["computeAttempted"])
        self.assertFalse(guard["postFixValidation"]["recoveryEligibility"]["eligible"])
        self.assertIn("recovery was already attempted", guard["postFixValidation"]["recoveryEligibility"]["reason"])
        self.assertFalse(summary["execution"]["computeAttempted"])

    def test_paid_failure_recurrence_guard_ignores_invalid_run_id_admission_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD):
                write_tencent_failure_summary(artifact_root, f"tencent-pg-room-busy-{index}")
            write_invalid_run_id_validation_admission_failure_summary(
                artifact_root,
                "cron-postfix-room-busy-recovery-preflight-20260530T063739Z",
            )
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "5",
                "--scale-environments",
                "5",
                "--repetitions",
                "5",
                "--allow-paid-failure-recurrence-validation",
                runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
            ])
            artifact_dir = artifact_root / "new-run"

            with mock.patch.object(
                runner,
                "paid_failure_recurrence_known_fix_status",
                return_value={
                    "signature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                    "issue": "#1501",
                    "pullRequest": "#1504",
                    "mergeCommit": "95f960b2",
                    "present": True,
                    "evidence": "merge commit 95f960b2 is reachable from HEAD",
                },
            ):
                events, controller, guard, summary = self.run_stubbed_compute(args, artifact_dir)

        self.assertIn("scale_up", events)
        self.assertIn("remote_training", events)
        self.assertFalse(guard["blocked"])
        self.assertEqual(guard["status"], runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_ALLOWED_STATUS)
        self.assertEqual(guard["postFixValidation"]["status"], "allowed")
        self.assertIsNone(guard["postFixValidation"]["priorAttempt"])
        self.assertEqual(controller.final_status, "completed")
        self.assertTrue(summary["execution"]["computeAttempted"])

    def test_paid_failure_recurrence_guard_blocks_second_validation_past_recent_summary_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            old_paths = [
                write_tencent_failure_summary(artifact_root, f"tencent-pg-room-busy-{index}")
                for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD)
            ]
            prior_attempt_path = write_post_fix_validation_summary(
                artifact_root,
                "tencent-pg-post-fix-failed",
                final_status="failed",
                failure_class=runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
            )
            newer_paths = [
                write_paid_failure_recurrence_skipped_summary(
                    artifact_root,
                    f"tencent-pg-newer-skipped-{index}",
                )
                for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_RECENT_SUMMARY_LIMIT)
            ]
            for index, summary_path in enumerate(old_paths):
                timestamp = 1_700_000_000 + index
                os.utime(summary_path, (timestamp, timestamp))
            os.utime(prior_attempt_path, (1_700_000_050, 1_700_000_050))
            for index, summary_path in enumerate(newer_paths):
                timestamp = 1_700_000_100 + index
                os.utime(summary_path, (timestamp, timestamp))
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "1",
                "--allow-paid-failure-recurrence-validation",
                runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
            ])
            artifact_dir = artifact_root / "new-run"

            with mock.patch.object(
                runner,
                "paid_failure_recurrence_known_fix_status",
                return_value={
                    "signature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                    "issue": "#1501",
                    "pullRequest": "#1504",
                    "mergeCommit": "95f960b2",
                    "present": True,
                    "evidence": "merge commit 95f960b2 is reachable from HEAD",
                },
            ):
                events, controller, guard, summary = self.run_stubbed_compute(args, artifact_dir)

        self.assertEqual(events, [])
        self.assertEqual(controller.final_status, runner.PAID_FAILURE_RECURRENCE_GUARD_FINAL_STATUS)
        self.assertTrue(guard["blocked"])
        self.assertEqual(guard["status"], runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_CONSUMED_STATUS)
        self.assertEqual(guard["postFixValidation"]["status"], "consumed")
        self.assertEqual(guard["postFixValidation"]["priorAttempt"]["runId"], "tencent-pg-post-fix-failed")
        self.assertIn("already attempted", guard["nextAction"])
        self.assertFalse(summary["execution"]["computeAttempted"])

    def test_paid_failure_recurrence_guard_completed_validation_resets_older_failures(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD):
                write_tencent_failure_summary(artifact_root, f"tencent-pg-room-busy-{index}")
            write_post_fix_validation_summary(
                artifact_root,
                "tencent-pg-post-fix-completed",
                final_status="completed",
            )
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "1",
            ])

            guard = runner.build_paid_failure_recurrence_launch_guard(
                args=args,
                run_id="new-run",
                artifact_dir=artifact_root / "new-run",
            )

        self.assertFalse(guard["blocked"])
        self.assertEqual(guard["status"], runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATED_STATUS)
        self.assertEqual(guard["postFixValidation"]["status"], "validated")
        recurrence_evidence = guard["postFixValidation"]["recurrenceEvidence"]
        self.assertTrue(recurrence_evidence["resetApplies"])
        self.assertEqual(recurrence_evidence["resetFailureCount"], runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD)
        self.assertEqual(recurrence_evidence["postValidationFailureCount"], 0)
        self.assertEqual(recurrence_evidence["unknownOrderFailureCount"], 0)
        self.assertIn("older room-busy recurrence evidence is reset", guard["nextAction"])

    def test_paid_failure_recurrence_guard_reblocks_after_completed_validation_recurrence(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD):
                write_tencent_failure_summary(artifact_root, f"tencent-pg-old-room-busy-{index}")
            write_post_fix_validation_summary(
                artifact_root,
                "tencent-pg-post-fix-completed",
                final_status="completed",
            )
            new_run_ids = {
                f"tencent-pg-new-room-busy-{index}"
                for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD)
            }
            for index, run_id in enumerate(sorted(new_run_ids)):
                summary_path = write_tencent_failure_summary(artifact_root, run_id)
                set_summary_finished_at(summary_path, f"2026-05-29T22:{index:02d}:03Z")
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "1",
            ])
            artifact_dir = artifact_root / "new-run"

            events, controller, guard, summary = self.run_stubbed_compute(args, artifact_dir)

        self.assertEqual(events, [])
        self.assertEqual(controller.final_status, runner.PAID_FAILURE_RECURRENCE_GUARD_FINAL_STATUS)
        self.assertTrue(guard["blocked"])
        self.assertEqual(guard["status"], runner.PAID_FAILURE_RECURRENCE_POST_FIX_VALIDATION_SUPERSEDED_STATUS)
        self.assertEqual(guard["postFixValidation"]["status"], "superseded")
        recurrence_evidence = guard["postFixValidation"]["recurrenceEvidence"]
        self.assertFalse(recurrence_evidence["resetApplies"])
        self.assertEqual(
            recurrence_evidence["postValidationFailureCount"],
            runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD,
        )
        self.assertEqual(recurrence_evidence["resetFailureCount"], runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD)
        self.assertEqual(
            {item["runId"] for item in recurrence_evidence["postValidationRuns"]},
            new_run_ids,
        )
        self.assertIn("newer matching failures", guard["nextAction"])
        self.assertEqual(summary["finalStatus"], runner.PAID_FAILURE_RECURRENCE_GUARD_FINAL_STATUS)
        self.assertFalse(summary["execution"]["computeAttempted"])
        summary_validation = summary["outputs"]["launchGuard"]["postFixValidation"]
        self.assertEqual(summary_validation["status"], "superseded")
        self.assertEqual(
            summary_validation["recurrenceEvidence"]["postValidationFailureCount"],
            runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD,
        )

    def test_paid_failure_recurrence_guard_scans_past_newer_skipped_guard_summaries(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            failure_paths = [
                write_tencent_failure_summary(artifact_root, f"tencent-pg-room-busy-{index}")
                for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD)
            ]
            skipped_paths = [
                write_paid_failure_recurrence_skipped_summary(
                    artifact_root,
                    f"tencent-pg-skipped-guard-{index}",
                )
                for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_RECENT_SUMMARY_LIMIT)
            ]
            for index, summary_path in enumerate(failure_paths):
                timestamp = 1_700_000_000 + index
                os.utime(summary_path, (timestamp, timestamp))
            for index, summary_path in enumerate(skipped_paths):
                timestamp = 1_700_000_100 + index
                os.utime(summary_path, (timestamp, timestamp))
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "1",
            ])

            with mock.patch.object(
                runner,
                "paid_failure_recurrence_known_fix_status",
                return_value={
                    "signature": runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE,
                    "issue": "#1501",
                    "pullRequest": "#1504",
                    "mergeCommit": "95f960b2",
                    "present": False,
                    "evidence": "merge commit 95f960b2 is not reachable from HEAD",
                },
            ):
                guard = runner.build_paid_failure_recurrence_launch_guard(
                    args=args,
                    run_id="new-run",
                    artifact_dir=artifact_root / "new-run",
                )

        self.assertTrue(guard["blocked"])
        self.assertEqual(guard["status"], "blocked")
        self.assertEqual(guard["evidence"]["activeSignature"], runner.PAID_FAILURE_PLACE_SPAWN_ROOM_BUSY_SIGNATURE)
        self.assertEqual(guard["evidence"]["count"], runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD)
        self.assertEqual(
            {item["runId"] for item in guard["evidence"]["runs"]},
            {f"tencent-pg-room-busy-{index}" for index in range(runner.PAID_FAILURE_RECURRENCE_GUARD_THRESHOLD)},
        )

    def test_no_arg_preflight_defaults_to_multi_tier_policy_gradient_without_repeat_guard(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for run_id in ("tencent-pg-1", "tencent-pg-2", "tencent-pg-3"):
                write_tencent_guard_summary(artifact_root, run_id)
            args = runner.parse_cli_args([
                "preflight",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
            ])
            artifact_dir = artifact_root / "new-run"

            events, controller, guard, summary = self.run_stubbed_preflight(args, artifact_dir)

        self.assertEqual(args.training_approach, "policy_gradient")
        self.assertEqual(args.scenario_id, runner.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(args.require_multi_tier_scenario)
        self.assertEqual(args.workers, 5)
        self.assertEqual(args.repetitions, 4)
        self.assertFalse(args.run_id.startswith("tencent-single-"))
        self.assertEqual(controller.final_status, "preflight_ok")
        self.assertEqual(summary["finalStatus"], "preflight_ok")
        self.assertEqual(summary["execution"]["command"], "preflight")
        self.assertEqual(summary["execution"]["mode"], "preflight")
        self.assertTrue(summary["execution"]["preflightOnly"])
        self.assertFalse(summary["execution"]["computeAttempted"])
        self.assertFalse(summary["execution"]["scaleOutAttempted"])
        self.assertFalse(summary["execution"]["remoteTrainingAttempted"])
        self.assertFalse(summary["execution"]["trainingReportProduced"])
        self.assertEqual(summary["execution"]["environmentsRun"], 0)
        self.assertEqual(summary["inputs"]["command"], "preflight")
        self.assertTrue(summary["inputs"]["preflightOnly"])
        self.assertEqual(summary["inputs"]["trainingApproach"], "policy_gradient")
        self.assertEqual(summary["inputs"]["scenarioId"], runner.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(summary["inputs"]["requireMultiTierScenario"])
        self.assertFalse(guard["blocked"])
        self.assertEqual(guard["status"], "clear")
        self.assertFalse(guard["currentLaunch"]["isE1S1SingleRoomNoHostile"])
        self.assertEqual(guard["currentLaunch"]["scenarioId"], runner.MULTI_TIER_SCENARIO_ID)
        self.assertEqual(guard["currentLaunch"]["effectiveTicks"], runner.POLICY_GRADIENT_MIN_SIMULATION_TICKS)
        self.assertEqual(
            guard["currentLaunch"]["policyGradientTrustSampleRequest"]["requestedSamplesPerCandidate"],
            20,
        )
        self.assertTrue(guard["currentLaunch"]["policyGradientTrustSampleRequest"]["meetsTrustSampleTarget"])
        self.assertEqual(guard["evidence"]["count"], 0)
        self.assertIn("experiment_card", events)
        self.assertNotIn("scale_up", events)

    def test_no_arg_run_single_defaults_to_multi_tier_policy_gradient_compute_mode(self) -> None:
        args = runner.parse_cli_args(["run-single"])

        self.assertEqual(args.command, "run-single")
        self.assertFalse(args.preflight_only)
        self.assertTrue(args.run_id.startswith("tencent-single-"))
        self.assertEqual(args.training_approach, "policy_gradient")
        self.assertEqual(args.scenario_id, runner.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(args.require_multi_tier_scenario)
        self.assertEqual(args.workers, 5)
        self.assertEqual(args.repetitions, 4)
        self.assertEqual(runner.policy_gradient_samples_per_candidate(args), 20)
        self.assertEqual(runner.effective_training_ticks(args), runner.POLICY_GRADIENT_MIN_SIMULATION_TICKS)

    def test_effective_training_ticks_preserves_non_policy_gradient_request(self) -> None:
        args = controller_args()
        args.training_approach = "bandit"
        args.ticks = 125

        self.assertEqual(runner.effective_training_ticks(args), 125)

    def test_preflight_command_uses_preflight_run_id_prefix(self) -> None:
        args = runner.parse_cli_args(["preflight"])

        self.assertEqual(args.command, "preflight")
        self.assertTrue(args.preflight_only)
        self.assertTrue(args.run_id.startswith("tencent-preflight-"))
        self.assertFalse(args.run_id.startswith("tencent-single-"))

    def test_cli_rejects_abbreviated_training_approach_option(self) -> None:
        with mock.patch("sys.stderr", new=io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                runner.parse_cli_args(["preflight", "--training-app", "bandit"])

        self.assertNotEqual(raised.exception.code, 0)

    def test_explicit_cli_option_dests_stops_at_option_separator(self) -> None:
        self.assertEqual(
            runner.explicit_cli_option_dests([
                "preflight",
                "--training-approach=bandit",
                "--",
                "--scenario-id",
                runner.DEFAULT_SCENARIO_ID,
            ]),
            {"training_approach"},
        )
        self.assertEqual(
            runner.explicit_cli_option_dests([
                "preflight",
                "--",
                "--training-approach",
                "bandit",
                f"--scenario-id={runner.DEFAULT_SCENARIO_ID}",
            ]),
            set(),
        )

    def test_explicit_e1s1_bandit_preflight_still_triggers_repeat_guard(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for run_id in ("tencent-pg-1", "tencent-pg-2", "tencent-pg-3"):
                write_tencent_guard_summary(artifact_root, run_id)
            args = runner.parse_cli_args([
                "preflight",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "bandit",
                "--scenario-id",
                runner.DEFAULT_SCENARIO_ID,
            ])
            artifact_dir = artifact_root / "new-run"

            events, controller, guard, summary = self.run_stubbed_preflight(args, artifact_dir)

        self.assertEqual(args.training_approach, "bandit")
        self.assertEqual(args.scenario_id, runner.DEFAULT_SCENARIO_ID)
        self.assertEqual(events, [])
        self.assertEqual(controller.final_status, runner.E1S1_REPEAT_GUARD_FINAL_STATUS)
        self.assertEqual(summary["finalStatus"], runner.E1S1_REPEAT_GUARD_FINAL_STATUS)
        self.assertTrue(guard["blocked"])
        self.assertEqual(guard["currentLaunch"]["scenarioId"], runner.DEFAULT_SCENARIO_ID)
        self.assertTrue(guard["currentLaunch"]["isE1S1SingleRoomNoHostile"])
        self.assertEqual(guard["currentLaunch"]["trainingApproach"], "bandit")
        self.assertEqual(guard["evidence"]["count"], 3)

    def test_explicit_multi_tier_preflight_includes_fixture_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            args = runner.parse_cli_args([
                "preflight",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
            ])
            artifact_dir = artifact_root / "new-run"

            events, controller, guard, summary = self.run_stubbed_preflight(args, artifact_dir)

        self.assertEqual(controller.final_status, "preflight_ok")
        self.assertEqual(summary["inputs"]["scenarioId"], runner.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(summary["inputs"]["requireMultiTierScenario"])
        self.assertEqual(summary["execution"]["mode"], "preflight")
        self.assertFalse(summary["execution"]["computeAttempted"])
        self.assertFalse(summary["execution"]["trainingReportProduced"])
        self.assertFalse(guard["blocked"])
        self.assertEqual(guard["currentLaunch"]["scenarioId"], runner.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(guard["currentLaunch"]["requireMultiTierScenario"])
        self.assertEqual(guard["currentLaunch"]["fixtureEvidence"]["adjacentRoom"], "E2S1")
        self.assertEqual(guard["currentLaunch"]["fixtureEvidence"]["neutralExpansionRoomCount"], 2)
        self.assertEqual(guard["currentLaunch"]["fixtureEvidence"]["hostileCreepCount"], 3)
        self.assertEqual(guard["currentLaunch"]["fixtureEvidence"]["hostileSpawnCount"], 1)
        self.assertEqual(guard["currentLaunch"]["fixtureEvidence"]["hostileTowerCount"], 1)
        self.assertIn("experiment_card", events)
        self.assertNotIn("scale_up", events)
        self.assertNotIn("bootstrap", events)
        self.assertNotIn("remote_training", events)

    def test_preflight_repeat_launch_guard_writes_skip_artifact_without_remote_side_effects(self) -> None:
        events: list[str] = []

        class FakeController(runner.Controller):
            def ensure_map_present(self) -> None:
                events.append("map")

            def ensure_dist_present(self) -> None:
                events.append("dist")

            def run_billing_guard(self) -> None:
                events.append("billing")

            def verify_security_group(self) -> None:
                events.append("security_group")

            def generate_experiment_card(self) -> None:
                events.append("experiment_card")

            def scale_up_and_wait(self) -> None:
                events.append("scale_up")

        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for run_id in ("tencent-pg-1", "tencent-pg-2", "tencent-pg-3"):
                write_tencent_guard_summary(artifact_root, run_id)
            args = controller_args()
            args.artifact_root = artifact_root
            args.preflight_only = True
            args.training_approach = "policy_gradient"
            args.ticks = 500
            args.explicit_cli_options = {"scenario_id"}
            artifact_dir = artifact_root / "new-run"
            controller = FakeController(args=args, run_id="new-run", artifact_dir=artifact_dir)

            with mock.patch.object(runner, "validate_static_inputs", return_value=None):
                controller.run()

            guard = json.loads((artifact_dir / "launch_guard.json").read_text(encoding="utf-8"))
            summary = json.loads((artifact_dir / "controller-summary.json").read_text(encoding="utf-8"))

        self.assertEqual(events, [])
        self.assertTrue(guard["blocked"])
        self.assertEqual(guard["status"], "blocked")
        self.assertEqual(controller.final_status, runner.E1S1_REPEAT_GUARD_FINAL_STATUS)
        self.assertEqual(summary["finalStatus"], runner.E1S1_REPEAT_GUARD_FINAL_STATUS)
        self.assertFalse(summary["safety"]["scaleDownAttempted"])
        self.assertEqual(summary["outputs"]["launchGuard"]["status"], "blocked")
        self.assertEqual(summary["execution"]["mode"], "preflight")
        self.assertFalse(summary["execution"]["computeAttempted"])
        self.assertFalse(summary["execution"]["scaleOutAttempted"])

    def test_multi_tier_run_single_proceeds_past_preflight_into_mocked_compute_path(self) -> None:
        events: list[str] = []

        class FakeController(runner.Controller):
            def ensure_map_present(self) -> None:
                events.append("map")

            def ensure_dist_present(self) -> None:
                events.append("dist")

            def run_billing_guard(self) -> None:
                events.append("billing")

            def verify_security_group(self) -> None:
                events.append("security_group")

            def generate_experiment_card(self) -> None:
                events.append("experiment_card")

            def scale_up_and_wait(self) -> None:
                events.append("scale_up")
                self.scaled_up = True
                self.instance_id = "ins-test"
                self.public_ip = "203.0.113.10"
                self.record_step("scale_up", 100.0, True, desiredCapacity=1)

            def verify_worker_security(self) -> None:
                events.append("worker_security")

            def bootstrap_worker(self) -> None:
                events.append("bootstrap")

            def transfer_repo_bundle(self) -> None:
                events.append("repo_bundle")

            def transfer_secret_env(self) -> None:
                events.append("secret_env")

            def run_remote_training(self) -> None:
                events.append("remote_training")
                self.record_step("remote_training", 101.0, True, reportId=self.run_id)

            def collect_remote_artifacts(self) -> None:
                events.append("collect_artifacts")

            def verify_remote_training_report(self) -> None:
                events.append("verify_training_report")
                self.result["trainingReport"] = {
                    "path": str(self.artifact_dir / "remote" / "runtime-artifacts" / "rl-training" / f"{self.run_id}.json"),
                    "reportId": self.run_id,
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                    "artifactCount": 5,
                    "scaleValidation": {
                        "ok": True,
                        "totalEnvironments": 5,
                        "successfulEnvironments": 5,
                        "minimumSuccessfulEnvironments": 4,
                    },
                }

            def scale_down(self) -> None:
                events.append("scale_down")
                self.record_step("scale_down", 102.0, True, desiredCapacity=0)

        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "1",
            ])
            artifact_dir = artifact_root / "new-run"
            controller = FakeController(args=args, run_id=args.run_id, artifact_dir=artifact_dir)

            with mock.patch.object(runner, "validate_static_inputs", return_value=None):
                controller.run()

            guard = json.loads((artifact_dir / "launch_guard.json").read_text(encoding="utf-8"))
            summary = json.loads((artifact_dir / "controller-summary.json").read_text(encoding="utf-8"))

        self.assertFalse(args.preflight_only)
        self.assertFalse(guard["blocked"])
        self.assertEqual(controller.final_status, "completed")
        self.assertEqual(summary["finalStatus"], "completed")
        self.assertNotEqual(summary["finalStatus"], "preflight_ok")
        self.assertEqual(summary["inputs"]["command"], "run-single")
        self.assertFalse(summary["inputs"]["preflightOnly"])
        self.assertEqual(summary["inputs"]["scenarioId"], runner.MULTI_TIER_SCENARIO_ID)
        self.assertEqual(summary["execution"]["command"], "run-single")
        self.assertEqual(summary["execution"]["mode"], "compute")
        self.assertFalse(summary["execution"]["preflightOnly"])
        self.assertTrue(summary["execution"]["computeAttempted"])
        self.assertTrue(summary["execution"]["scaleOutAttempted"])
        self.assertTrue(summary["execution"]["remoteTrainingAttempted"])
        self.assertTrue(summary["execution"]["trainingReportProduced"])
        self.assertEqual(summary["execution"]["trainingReportId"], "new-run")
        self.assertEqual(summary["execution"]["artifactCount"], 5)
        self.assertEqual(summary["execution"]["environmentsRun"], 5)
        self.assertEqual(summary["instanceId"], "ins-test")
        self.assertIn("scale_up", events)
        self.assertIn("bootstrap", events)
        self.assertIn("remote_training", events)
        self.assertIn("verify_training_report", events)
        self.assertLess(events.index("experiment_card"), events.index("scale_up"))

    def test_static_validation_accepts_bounded_multi_worker_scale_proof(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            args = controller_args()
            args.tccli = str(root / "tccli")
            args.billing_guard = str(root / "billing-guard.py")
            args.ssh_key = str(root / "id_ed25519")
            args.secret_env = str(root / ".env")
            args.workers = 5
            for path in (args.tccli, args.billing_guard, args.ssh_key, args.secret_env):
                write_text(Path(path))

            runner.validate_static_inputs(args, "run-test")

            args.scale_environments = 6
            with self.assertRaisesRegex(runner.BatchRunError, "workers must be at least scale environments"):
                runner.validate_static_inputs(args, "run-test")

            args.scale_environments = None
            args.workers = runner.MAX_SCALE_PROOF_WORKERS + 1
            with self.assertRaisesRegex(runner.BatchRunError, "workers must be between"):
                runner.validate_static_inputs(args, "run-test")

            args.workers = 1
            args.require_multi_tier_scenario = True
            args.scenario_id = runner.DEFAULT_SCENARIO_ID
            with self.assertRaisesRegex(runner.BatchRunError, "multi-tier policy comparisons require"):
                runner.validate_static_inputs(args, "run-test")

            args.scenario_id = runner.MULTI_TIER_SCENARIO_ID
            runner.validate_static_inputs(args, "run-test")

            args.training_approach = "policy_gradient"
            args.explicit_cli_options = {"scenario_id"}
            args.scenario_id = runner.DEFAULT_SCENARIO_ID
            args.require_multi_tier_scenario = False
            with self.assertRaisesRegex(runner.BatchRunError, "policy_gradient Tencent proof requires"):
                runner.validate_static_inputs(args, "run-test")

            args.scenario_id = legacy_multi_tier_scenario_id()
            args.require_multi_tier_scenario = False
            with self.assertRaisesRegex(runner.BatchRunError, "policy_gradient Tencent proof requires"):
                runner.validate_static_inputs(args, "run-test")

            args.scenario_id = runner.MULTI_TIER_SCENARIO_ID
            args.require_multi_tier_scenario = True
            runner.validate_static_inputs(args, "run-test")

    def test_static_validation_rejects_s3_validation_scale_above_resource_guard_cap(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            args = controller_args()
            args.tccli = str(root / "tccli")
            args.billing_guard = str(root / "billing-guard.py")
            args.ssh_key = str(root / "id_ed25519")
            args.secret_env = str(root / ".env")
            args.workers = 16
            args.scale_environments = 16
            for path in (args.tccli, args.billing_guard, args.ssh_key, args.secret_env):
                write_text(Path(path))

            with self.assertRaisesRegex(
                runner.BatchRunError,
                r"S3\.2XLARGE16 validation cap exceeded.*38336 MiB.*--workers 6 --scale-environments 6",
            ) as raised:
                runner.validate_static_inputs(args, "run-test")
            self.assertIn("currently enforces the S3.2XLARGE16 validation cap", str(raised.exception))
            self.assertNotIn("larger memory instance", str(raised.exception))

            args.workers = runner.TENCENT_S3_2XLARGE16_MAX_VALIDATION_ENVIRONMENTS
            args.scale_environments = runner.TENCENT_S3_2XLARGE16_MAX_VALIDATION_ENVIRONMENTS
            runner.validate_static_inputs(args, "run-test")

            args.workers = runner.TENCENT_S3_2XLARGE16_MAX_VALIDATION_ENVIRONMENTS + 1
            args.scale_environments = None
            with self.assertRaisesRegex(runner.BatchRunError, "validation cap exceeded"):
                runner.validate_static_inputs(args, "run-test")

    def test_policy_gradient_cli_defaults_to_multi_tier_required_scenario(self) -> None:
        args = runner.build_parser().parse_args([
            "preflight",
            "--training-approach",
            "policy_gradient",
        ])

        runner.apply_cli_scenario_defaults(args)

        self.assertEqual(args.scenario_id, runner.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(args.require_multi_tier_scenario)
        self.assertEqual(args.workers, 5)
        self.assertEqual(args.repetitions, 4)

    def test_policy_gradient_legacy_v0_default_resolves_to_active_multi_tier_scenario(self) -> None:
        args = controller_args()
        args.training_approach = "policy_gradient"
        args.scenario_id = legacy_multi_tier_scenario_id()
        args.require_multi_tier_scenario = False

        runner.apply_cli_scenario_defaults(args)

        self.assertEqual(args.scenario_id, runner.MULTI_TIER_SCENARIO_ID)
        self.assertEqual(runner.scenario_id_from_args(args), runner.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(runner.require_multi_tier_scenario_from_args(args))

    def test_policy_gradient_explicit_v0_cli_request_is_rejected_by_static_guard(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            args = runner.parse_cli_args([
                "preflight",
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                legacy_multi_tier_scenario_id(),
            ])
            args.tccli = str(root / "tccli")
            args.billing_guard = str(root / "billing-guard.py")
            args.ssh_key = str(root / "id_ed25519")
            args.secret_env = str(root / ".env")
            for path in (args.tccli, args.billing_guard, args.ssh_key, args.secret_env):
                write_text(Path(path))

            with self.assertRaisesRegex(runner.BatchRunError, "policy_gradient Tencent proof requires"):
                runner.validate_static_inputs(args, "run-test")

    def test_policy_gradient_validation_defaults_tolerate_unset_workers_and_repetitions(self) -> None:
        args = runner.build_parser().parse_args([
            "preflight",
            "--training-approach",
            "policy_gradient",
        ])
        args.workers = None
        args.repetitions = None

        runner.apply_cli_scenario_defaults(args)

        self.assertEqual(args.workers, 5)
        self.assertEqual(args.repetitions, 4)

    def test_generate_experiment_card_writes_multi_environment_scale_proof_spec(self) -> None:
        args = controller_args()
        args.workers = 5
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=root)

            def fake_run_cp(name: str, cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                if name == "generate_experiment_card":
                    output = Path(cmd[cmd.index("--output") + 1])
                    output.write_text(json.dumps(generated_experiment_card()), encoding="utf-8")
                return subprocess.CompletedProcess(cmd, 0, "{}", "")

            with mock.patch.object(controller, "run_cp", side_effect=fake_run_cp):
                controller.generate_experiment_card()

            card = json.loads((root / "experiment_card.json").read_text(encoding="utf-8"))
            spec = json.loads((root / "scale_proof_spec.json").read_text(encoding="utf-8"))

        self.assertEqual(card["status"], "shadow")
        self.assertFalse(card["liveEffect"])
        self.assertFalse(card["officialMmoWrites"])
        self.assertFalse(card["officialMmoWritesAllowed"])
        self.assertEqual(card["simulation"]["workers"], 5)
        self.assertEqual(card["simulation"]["scale_environments"], 5)
        self.assertEqual(card["simulation"]["min_concurrent_environments"], 5)
        self.assertEqual(card["scenario"]["evidence"]["map_source_file"], "maps/map-0b6758af.json")
        self.assertEqual(spec["scaleProof"]["mode"], "single_tencent_asg_worker_multi_environment")
        self.assertEqual(spec["scaleProof"]["successCriteria"]["minimumSuccessfulEnvironments"], 4)
        self.assertEqual(spec["experimentCard"]["scenario"]["scenario_id"], runner.DEFAULT_SCENARIO_ID)
        self.assertEqual(spec["asg"]["desiredCapacityDuringRun"], 1)
        self.assertEqual(spec["asg"]["cleanupDesiredCapacity"], 0)
        self.assertTrue(spec["safety"]["billingGuardBeforeScale"])
        self.assertFalse(spec["safety"]["officialMmoWritesAllowed"])
        self.assertEqual(controller.steps[-1].name, "write_scale_proof_spec")

    def test_generate_policy_gradient_experiment_card_floors_tencent_ticks_to_long_horizon(self) -> None:
        args = controller_args()
        args.training_approach = "policy_gradient"
        args.ticks = 200
        args.workers = 5
        args.repetitions = 5
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=root)
            observed_cmds: list[list[str]] = []

            def fake_run_cp(name: str, cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                observed_cmds.append(cmd)
                if name == "generate_experiment_card":
                    output = Path(cmd[cmd.index("--output") + 1])
                    requested_scenario_id = cmd[cmd.index("--scenario-id") + 1]
                    payload = card_helper.build_card(
                        dataset_run_id="dataset-test",
                        code_commit="a" * 40,
                        training_approach="policy_gradient",
                        created_at="2026-05-18T10:18:00Z",
                        loop_a_card_supply="--loop-a-policy-gradient-supply" in cmd,
                        scenario_id=requested_scenario_id,
                        require_multi_tier_scenario="--require-multi-tier-scenario" in cmd,
                    )
                    payload["simulation"]["ticks"] = 100
                    payload["simulation"]["workers"] = 1
                    payload["simulation"]["repetitions"] = 1
                    output.write_text(json.dumps(payload), encoding="utf-8")
                return subprocess.CompletedProcess(cmd, 0, "{}", "")

            with mock.patch.object(controller, "run_cp", side_effect=fake_run_cp):
                controller.generate_experiment_card()

            card = json.loads((root / "experiment_card.json").read_text(encoding="utf-8"))
            spec = json.loads((root / "scale_proof_spec.json").read_text(encoding="utf-8"))

        generate_cmd = observed_cmds[0]
        self.assertEqual(generate_cmd[generate_cmd.index("--scenario-id") + 1], runner.MULTI_TIER_SCENARIO_ID)
        self.assertIn("--require-multi-tier-scenario", generate_cmd)
        self.assertEqual(card["training_approach"], "policy_gradient")
        self.assertIn("--loop-a-policy-gradient-supply", generate_cmd)
        self.assertEqual(card["card_supply"]["type"], "screeps-rl-loop-a-card-supply")
        self.assertEqual(card["card_supply"]["consumer"], "loop-a-policy-gradient")
        self.assertTrue(card["card_supply"]["available_for_training"])
        self.assertEqual(card["scenario"]["scenario_id"], runner.MULTI_TIER_SCENARIO_ID)
        self.assertEqual(card["simulation"]["map_source_file"], runner.MULTI_TIER_SIMULATION_MAP_SOURCE_REL)
        self.assertEqual(card["simulation"]["ticks"], runner.POLICY_GRADIENT_MIN_SIMULATION_TICKS)
        self.assertEqual(card["simulation"]["workers"], 5)
        self.assertEqual(card["simulation"]["repetitions"], 5)
        self.assertFalse(card["officialMmoWrites"])
        self.assertFalse(card["officialMmoWritesAllowed"])
        self.assertEqual(controller.result["experimentCard"]["trainingApproach"], "policy_gradient")
        self.assertEqual(controller.result["experimentCard"]["cardSupply"]["state"], "available")
        self.assertEqual(spec["experimentCard"]["cardSupply"]["state"], "available")
        self.assertEqual(spec["experimentCard"]["scenario"]["scenario_id"], runner.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(spec["scaleProof"]["remoteRunnerContract"]["requireMultiTierScenario"])
        self.assertEqual(
            spec["scaleProof"]["remoteRunnerContract"]["cardSimulationFields"]["scenario_id"],
            runner.MULTI_TIER_SCENARIO_ID,
        )
        self.assertEqual(
            spec["scaleProof"]["remoteRunnerContract"]["cardSimulationFields"]["ticks"],
            runner.POLICY_GRADIENT_MIN_SIMULATION_TICKS,
        )

    def test_run_remote_training_collects_diagnostics_on_exit_two(self) -> None:
        args = controller_args()
        args.training_timeout_seconds = 30
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=root)
            calls: list[tuple[str, dict[str, object]]] = []

            def fake_ssh_cmd(
                name: str,
                _remote_command: str,
                **kwargs: object,
            ) -> subprocess.CompletedProcess[str]:
                calls.append((name, kwargs))
                return subprocess.CompletedProcess(["ssh"], 2, "", "")

            def fake_collect_remote_artifacts() -> None:
                remote = root / "remote"
                remote.mkdir(parents=True)
                (remote / "training-stderr.log").write_text(
                    "STEAM_KEY=secret-value\nerror: simulator argument rejected\n",
                    encoding="utf-8",
                )
                (remote / "training-summary.json").write_text("", encoding="utf-8")
                (remote / "card-validation.json").write_text('{"ok": true}\n', encoding="utf-8")
                (remote / "report-extract.json").write_text("", encoding="utf-8")

            with (
                mock.patch.object(controller, "ssh_cmd", side_effect=fake_ssh_cmd),
                mock.patch.object(controller, "collect_remote_artifacts", side_effect=fake_collect_remote_artifacts),
            ):
                with self.assertRaisesRegex(
                    runner.BatchRunError,
                    "training-stderr.log: STEAM_KEY=\\[REDACTED\\]\\nerror: simulator argument rejected",
                ):
                    controller.run_remote_training()

            self.assertEqual(calls[0][0], "remote_training")
            self.assertIs(calls[0][1]["check"], False)
            failure = controller.result["remoteTrainingFailure"]
            self.assertEqual(failure["returncode"], 2)
            stderr = failure["diagnostics"]["training-stderr.log"]
            self.assertIn("simulator argument rejected", stderr["tail"])
            self.assertIn("STEAM_KEY=[REDACTED]", stderr["tail"])
            self.assertNotIn("secret-value", stderr["tail"])

    def test_run_remote_training_classifies_timeout_and_collects_partial_diagnostics(self) -> None:
        args = controller_args()
        args.training_timeout_seconds = 3600
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=root)
            calls: list[tuple[str, dict[str, object]]] = []

            def fake_ssh_cmd(
                name: str,
                _remote_command: str,
                **kwargs: object,
            ) -> subprocess.CompletedProcess[str]:
                calls.append((name, kwargs))
                return runner.timeout_completed_process(
                    ["ssh"],
                    subprocess.TimeoutExpired(
                        ["ssh"],
                        3600,
                        output=b"",
                        stderr=b"validation heartbeat: environmentsStarted=0 environmentsCompleted=0\n",
                    ),
                )

            def fake_collect_remote_artifacts() -> None:
                remote = root / "remote"
                remote.mkdir(parents=True)
                (remote / "training-stderr.log").write_text(
                    "validation heartbeat: environmentsStarted=0 environmentsCompleted=0\n",
                    encoding="utf-8",
                )
                (remote / "training-summary.json").write_text("", encoding="utf-8")
                (remote / "card-validation.json").write_text('{"ok": true}\n', encoding="utf-8")
                (remote / "report-extract.json").write_text("", encoding="utf-8")

            with (
                mock.patch.object(controller, "ssh_cmd", side_effect=fake_ssh_cmd),
                mock.patch.object(controller, "collect_remote_artifacts", side_effect=fake_collect_remote_artifacts),
            ):
                with self.assertRaisesRegex(runner.BatchRunError, "validation heartbeat"):
                    controller.run_remote_training()

            failure = controller.result["remoteTrainingFailure"]

        self.assertEqual(calls[0][0], "remote_training")
        self.assertEqual(calls[0][1]["timeout"], 3600)
        self.assertEqual(failure["returncode"], runner.PROCESS_TIMEOUT_RETURN_CODE)
        self.assertEqual(failure["failureClass"], "remote_training_timeout")
        self.assertTrue(failure["controllerTimedOut"])
        self.assertFalse(failure["retryable"])
        self.assertIn("smaller chunks", failure["nextAction"])
        self.assertIn(
            "validation heartbeat",
            failure["diagnostics"]["training-stderr.log"]["tail"],
        )

    def test_run_remote_training_keeps_timeout_for_nonterminal_room_busy_retry_telemetry(self) -> None:
        args = controller_args()
        args.training_timeout_seconds = 3600
        retry_log = "\n".join(
            [
                (
                    "2026-05-30T21:18:41Z rl-sim-worker[0] variant=baseline "
                    'phase="place-spawn room busy; retrying" '
                    'attempt="1" maxAttempts="12" retrySeconds="1.0"'
                ),
                (
                    "2026-05-30T21:21:31Z rl-sim-worker[2] variant=baseline "
                    'phase="place-spawn room busy; retrying" '
                    'attempt="1" maxAttempts="12" retrySeconds="1.0"'
                ),
            ]
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=root)

            def fake_ssh_cmd(
                _name: str,
                _remote_command: str,
                **_kwargs: object,
            ) -> subprocess.CompletedProcess[str]:
                return runner.timeout_completed_process(
                    ["ssh"],
                    subprocess.TimeoutExpired(["ssh"], 3600, output=b"", stderr=retry_log.encode()),
                )

            def fake_collect_remote_artifacts() -> None:
                remote = root / "remote"
                remote.mkdir(parents=True)
                (remote / "training-stderr.log").write_text(f"{retry_log}\n", encoding="utf-8")
                (remote / "training-summary.json").write_text("", encoding="utf-8")
                (remote / "card-validation.json").write_text('{"ok": true}\n', encoding="utf-8")
                (remote / "report-extract.json").write_text("", encoding="utf-8")

            with (
                mock.patch.object(controller, "ssh_cmd", side_effect=fake_ssh_cmd),
                mock.patch.object(controller, "collect_remote_artifacts", side_effect=fake_collect_remote_artifacts),
            ):
                with self.assertRaisesRegex(runner.BatchRunError, "place-spawn room busy; retrying"):
                    controller.run_remote_training()

            failure = controller.result["remoteTrainingFailure"]

        self.assertEqual(failure["returncode"], runner.PROCESS_TIMEOUT_RETURN_CODE)
        self.assertEqual(failure["failureClass"], "remote_training_timeout")
        self.assertTrue(failure["controllerTimedOut"])
        self.assertFalse(failure["retryable"])
        self.assertIn("smaller chunks", failure["nextAction"])

    def test_run_remote_training_does_not_classify_remote_exit_124_as_controller_timeout(self) -> None:
        args = controller_args()
        args.training_timeout_seconds = 3600
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=root)

            def fake_ssh_cmd(
                _name: str,
                _remote_command: str,
                **_kwargs: object,
            ) -> subprocess.CompletedProcess[str]:
                return subprocess.CompletedProcess(
                    ["ssh"],
                    runner.PROCESS_TIMEOUT_RETURN_CODE,
                    "",
                    "remote command exited 124\n",
                )

            def fake_collect_remote_artifacts() -> None:
                remote = root / "remote"
                remote.mkdir(parents=True)
                (remote / "training-stderr.log").write_text(
                    "remote process exited with status 124\n",
                    encoding="utf-8",
                )
                (remote / "training-summary.json").write_text("", encoding="utf-8")
                (remote / "card-validation.json").write_text('{"ok": true}\n', encoding="utf-8")
                (remote / "report-extract.json").write_text("", encoding="utf-8")

            with (
                mock.patch.object(controller, "ssh_cmd", side_effect=fake_ssh_cmd),
                mock.patch.object(controller, "collect_remote_artifacts", side_effect=fake_collect_remote_artifacts),
            ):
                with self.assertRaisesRegex(runner.BatchRunError, "remote process exited with status 124"):
                    controller.run_remote_training()

            failure = controller.result["remoteTrainingFailure"]

        self.assertEqual(failure["returncode"], runner.PROCESS_TIMEOUT_RETURN_CODE)
        self.assertEqual(failure["failureClass"], "remote_process_failed")
        self.assertFalse(failure["retryable"])
        self.assertNotIn("controllerTimedOut", failure)
        self.assertNotIn("nextAction", failure)

    def test_run_remote_training_classifies_ssh_server_timeout(self) -> None:
        args = controller_args()
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=root)

            def fake_ssh_cmd(
                _name: str,
                _remote_command: str,
                **_kwargs: object,
            ) -> subprocess.CompletedProcess[str]:
                return subprocess.CompletedProcess(
                    ["ssh"],
                    255,
                    "",
                    "Timeout, server 43.134.24.175 not responding.\n",
                )

            with (
                mock.patch.object(controller, "ssh_cmd", side_effect=fake_ssh_cmd),
                mock.patch.object(
                    controller,
                    "collect_remote_artifacts",
                    side_effect=runner.BatchRunError("worker still unreachable"),
                ),
            ):
                with self.assertRaisesRegex(runner.BatchRunError, "Timeout, server 43.134.24.175 not responding"):
                    controller.run_remote_training()

            failure = controller.result["remoteTrainingFailure"]

        self.assertEqual(failure["failureClass"], "network_unreachable")
        self.assertTrue(failure["retryable"])
        self.assertIn("worker still unreachable", failure["collectionError"])

    def test_run_remote_training_classifies_resource_guard_failure_artifact(self) -> None:
        args = controller_args()
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=root)

            def fake_ssh_cmd(
                _name: str,
                _remote_command: str,
                **_kwargs: object,
            ) -> subprocess.CompletedProcess[str]:
                return subprocess.CompletedProcess(["ssh"], 2, "", "")

            def fake_collect_remote_artifacts() -> None:
                remote = root / "remote"
                simulator = remote / "simulator-artifacts" / "run-test"
                simulator.mkdir(parents=True)
                (remote / "training-stderr.log").write_text(
                    "error: resource guard rejected simulator scale run: "
                    "workers=5 effectiveWorkers=5 requires 34036 MiB memory/swap; "
                    "15 active rl-sim/private-smoke Docker container(s) already running\n",
                    encoding="utf-8",
                )
                (remote / "training-summary.json").write_text("", encoding="utf-8")
                (remote / "card-validation.json").write_text('{"ok": true}\n', encoding="utf-8")
                (remote / "report-extract.json").write_text("", encoding="utf-8")
                (simulator / "resource_guard_failure.json").write_text(
                    json.dumps(
                        {
                            "type": "screeps-rl-simulator-resource-guard-failure",
                            "phase": "resource-guard",
                            "resourceGuard": {
                                "decision": "rejected",
                                "requestedWorkers": 5,
                                "effectiveWorkers": 5,
                                "guardedWorkerEstimate": 5,
                                "reasons": [
                                    "workers=5 effectiveWorkers=5 requires 34036 MiB memory/swap; host reports 14242 MiB",
                                    "15 active rl-sim/private-smoke Docker container(s) already running",
                                ],
                                "host": {
                                    "memoryAndSwapAvailableMiB": 14242,
                                    "activeSimulatorContainerCount": 15,
                                    "activeRlSimulatorContainerCount": 0,
                                    "activePrivateSmokeContainerCount": 15,
                                },
                                "estimate": {
                                    "requiredMemoryAndSwapMiB": 34036,
                                    "hostReserveMiB": 1536,
                                    "memoryPerWorkerMiB": 2300,
                                    "activeStackMemoryMiB": 1400,
                                },
                                "scaleValidation": {
                                    "minConcurrentEnvironments": 5,
                                    "targetConcurrencyMet": True,
                                    "recommendations": [
                                        "stop 15 active rl-sim/private-smoke Docker container(s) before the scale proof",
                                    ],
                                },
                            },
                        }
                    ),
                    encoding="utf-8",
                )

            with (
                mock.patch.object(controller, "ssh_cmd", side_effect=fake_ssh_cmd),
                mock.patch.object(controller, "collect_remote_artifacts", side_effect=fake_collect_remote_artifacts),
            ):
                with self.assertRaisesRegex(runner.BatchRunError, "resource guard rejected simulator scale run"):
                    controller.run_remote_training()

            failure = controller.result["remoteTrainingFailure"]

        self.assertEqual(failure["failureClass"], "simulator_resource_guard_rejected")
        self.assertFalse(failure["retryable"])
        self.assertEqual(failure["resourceGuard"]["effectiveWorkers"], 5)
        self.assertEqual(failure["resourceGuard"]["host"]["activePrivateSmokeContainerCount"], 15)
        self.assertEqual(failure["resourceGuard"]["estimate"]["requiredMemoryAndSwapMiB"], 34036)
        self.assertIn(
            "simulator-artifacts/run-test/resource_guard_failure.json",
            failure["diagnostics"],
        )

    def test_run_remote_training_classifies_retryable_simulator_setup_failure(self) -> None:
        args = controller_args()
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=root)

            def fake_ssh_cmd(
                _name: str,
                _remote_command: str,
                **_kwargs: object,
            ) -> subprocess.CompletedProcess[str]:
                return subprocess.CompletedProcess(["ssh"], 2, "", "")

            def fake_collect_remote_artifacts() -> None:
                remote = root / "remote"
                remote.mkdir(parents=True)
                (remote / "training-stderr.log").write_text(
                    "pre-scale private-simulator trainability smoke gate failed: "
                    "docker compose up failed after 2 attempt(s): retryable setup failure: unexpected EOF\n",
                    encoding="utf-8",
                )
                (remote / "training-summary.json").write_text("", encoding="utf-8")
                (remote / "card-validation.json").write_text('{"ok": true}\n', encoding="utf-8")
                (remote / "report-extract.json").write_text("", encoding="utf-8")

            with (
                mock.patch.object(controller, "ssh_cmd", side_effect=fake_ssh_cmd),
                mock.patch.object(controller, "collect_remote_artifacts", side_effect=fake_collect_remote_artifacts),
            ):
                with self.assertRaisesRegex(runner.BatchRunError, "docker compose up failed"):
                    controller.run_remote_training()

            failure = controller.result["remoteTrainingFailure"]

        self.assertEqual(failure["failureClass"], "simulator_setup_retryable")
        self.assertTrue(failure["retryable"])
        self.assertIn("rerun", failure["nextAction"])

    def test_setup_context_network_timeout_keeps_docker_setup_guidance(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            remote = root / "remote"
            remote.mkdir()
            (remote / "training-stderr.log").write_text(
                "pre-scale private-simulator trainability smoke gate failed: "
                "docker compose pull failed after 2 attempt(s): Client.Timeout exceeded\n",
                encoding="utf-8",
            )

            failure = runner.remote_training_failure_diagnostics(root, 2, run_id="run-test")

        self.assertEqual(failure["failureClass"], "simulator_setup_retryable")
        self.assertTrue(failure["retryable"])
        self.assertIn("Docker image pull/setup", failure["nextAction"])

    def test_setup_context_interrupted_pull_progress_is_retryable_setup_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            remote = root / "remote"
            remote.mkdir()
            (remote / "training-stderr.log").write_text(
                "pre-scale private-simulator trainability smoke gate failed: "
                "docker compose pull failed: {'ok': True, 'payload': "
                "'{\"attempts\": [{\"attempt\": 1, \"elapsedSeconds\": 64.967, "
                "\"outputExcerpt\": \" mongo Pulling \\\\n screeps Pulling \\\\n redis Pulling \\\\n "
                "3892befd2c3f Pulling fs layer \\\\n 32ab8bed435e Download complete \\\\n "
                "3892befd2c3f Downloading\"}]}' }\n",
                encoding="utf-8",
            )

            failure = runner.remote_training_failure_diagnostics(root, 2, run_id="run-test")

        self.assertEqual(failure["failureClass"], "simulator_setup_retryable")
        self.assertTrue(failure["retryable"])
        self.assertIn("Docker image pull/setup", failure["nextAction"])

    def test_pre_scale_smoke_setup_artifact_is_collected_as_retryable_setup_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            setup_dir = root / "remote" / "simulator-artifacts" / "run-test-pre-scale-smoke"
            setup_dir.mkdir(parents=True)
            (setup_dir / "setup_failure.json").write_text(
                json.dumps(
                    {
                        "type": "screeps-rl-simulator-setup-failure",
                        "phase": "run-variants",
                        "error": (
                            "docker compose pull failed after 4 attempt(s): "
                            "retryable_setup_failure: screeps Pulling; 3892befd2c3f Downloading"
                        ),
                    }
                ),
                encoding="utf-8",
            )

            failure = runner.remote_training_failure_diagnostics(root, 2, run_id="run-test")

        self.assertEqual(failure["failureClass"], "simulator_setup_retryable")
        self.assertTrue(failure["retryable"])
        self.assertIn(
            "simulator-artifacts/run-test-pre-scale-smoke/setup_failure.json",
            failure["diagnostics"],
        )

    def test_setup_context_terminal_pull_error_is_not_retryable_setup_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            remote = root / "remote"
            remote.mkdir()
            (remote / "training-stderr.log").write_text(
                "pre-scale private-simulator trainability smoke gate failed: "
                "docker compose pull failed: screeps Pulling\n"
                "manifest for screeps/private-server:missing not found\n",
                encoding="utf-8",
            )

            failure = runner.remote_training_failure_diagnostics(root, 2, run_id="run-test")

        self.assertEqual(failure["failureClass"], "remote_process_failed")
        self.assertFalse(failure["retryable"])
        self.assertNotIn("nextAction", failure)

    def test_setup_context_terminal_disk_error_is_not_retryable_setup_failure(self) -> None:
        for message in ("no space left on device", "disk quota exceeded", "read-only file system"):
            with self.subTest(message=message):
                with tempfile.TemporaryDirectory() as temp_dir:
                    root = Path(temp_dir)
                    remote = root / "remote"
                    remote.mkdir()
                    (remote / "training-stderr.log").write_text(
                        "pre-scale private-simulator trainability smoke gate failed: "
                        "docker compose pull failed: screeps Pulling\n"
                        f"3892befd2c3f Pulling fs layer\n{message}\n",
                        encoding="utf-8",
                    )

                    failure = runner.remote_training_failure_diagnostics(root, 2, run_id="run-test")

                self.assertEqual(failure["failureClass"], "remote_process_failed")
                self.assertFalse(failure["retryable"])
                self.assertNotIn("nextAction", failure)

    def test_generic_network_api_diagnostic_does_not_get_docker_setup_guidance(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            remote = root / "remote"
            remote.mkdir()
            (remote / "training-stderr.log").write_text(
                "Tencent API request canceled: too many requests while polling batch status\n",
                encoding="utf-8",
            )

            failure = runner.remote_training_failure_diagnostics(root, 2, run_id="run-test")

        self.assertEqual(failure["failureClass"], "remote_process_failed")
        self.assertFalse(failure["retryable"])
        self.assertNotIn("nextAction", failure)

    def test_runtime_parameter_smoke_failure_remains_non_retryable_remote_process_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            remote = root / "remote"
            remote.mkdir()
            (remote / "training-stderr.log").write_text(
                "pre-scale private-simulator trainability smoke gate did not prove runtime parameter consumption: missing\n",
                encoding="utf-8",
            )

            failure = runner.remote_training_failure_diagnostics(root, 2, run_id="run-test")

        self.assertEqual(failure["failureClass"], "remote_process_failed")
        self.assertFalse(failure["retryable"])
        self.assertNotIn("nextAction", failure)

    def test_place_spawn_room_busy_smoke_failure_gets_specific_non_retryable_guidance(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            remote = root / "remote"
            remote.mkdir()
            (remote / "training-stderr.log").write_text(
                "pre-scale private-simulator trainability smoke gate failed: "
                "place-spawn room busy after 12 attempt(s): "
                '{"classification": "place_spawn_room_busy"}\n',
                encoding="utf-8",
            )

            failure = runner.remote_training_failure_diagnostics(root, 2, run_id="run-test")

        self.assertEqual(failure["failureClass"], "simulator_place_spawn_room_busy")
        self.assertFalse(failure["retryable"])
        self.assertIn("do not rerun paid validation unchanged", failure["nextAction"])

    def test_recovered_place_spawn_room_busy_retry_log_does_not_override_later_retryable_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            remote = root / "remote"
            remote.mkdir()
            (remote / "training-stderr.log").write_text(
                "place-spawn room busy; retrying attempt=1 maxAttempts=12 retrySeconds=30\n"
                "Client.Timeout exceeded while polling batch status\n",
                encoding="utf-8",
            )

            failure = runner.remote_training_failure_diagnostics(root, 255, run_id="run-test")

        self.assertEqual(failure["failureClass"], "network_unreachable")
        self.assertTrue(failure["retryable"])
        self.assertIn("worker SSH/network", failure["nextAction"])

    def test_diagnostic_redaction_covers_common_secret_formats(self) -> None:
        raw = (
            "STEAM_KEY=steam-secret\n"
            "SCREEPS_AUTH_TOKEN: screeps-secret\n"
            '"GITHUB_TOKEN": "github-secret"\n'
            "'TENCENT_SECRET_ID': 'tencent-secret-id'\n"
            'OPENAI_API_KEY = "openai-secret"\n'
            'vendor_api_key: "vendor-secret"\n'
            "cache_key: cache-visible\n"
            "error: simulator argument rejected\n"
        )

        redacted = runner.diagnostic_tail(raw, 5000)

        for secret in (
            "steam-secret",
            "screeps-secret",
            "github-secret",
            "tencent-secret-id",
            "openai-secret",
            "vendor-secret",
        ):
            self.assertNotIn(secret, redacted)
        self.assertIn("STEAM_KEY=[REDACTED]", redacted)
        self.assertIn("SCREEPS_AUTH_TOKEN: [REDACTED]", redacted)
        self.assertIn('"GITHUB_TOKEN": "[REDACTED]"', redacted)
        self.assertIn("'TENCENT_SECRET_ID': '[REDACTED]'", redacted)
        self.assertIn('OPENAI_API_KEY = "[REDACTED]"', redacted)
        self.assertIn('vendor_api_key: "[REDACTED]"', redacted)
        self.assertIn("cache_key: cache-visible", redacted)
        self.assertIn("error: simulator argument rejected", redacted)

    def test_remote_training_failure_diagnostics_reads_bounded_tail_only(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            remote = root / "remote"
            remote.mkdir()
            for filename in runner.REMOTE_TRAINING_DIAGNOSTIC_FILES:
                (remote / filename).write_text("", encoding="utf-8")
            (remote / "training-stderr.log").write_text(
                "old failure marker\n"
                + ("x" * (runner.DIAGNOSTIC_FILE_TAIL_BYTES + 128))
                + "\nGITHUB_TOKEN=tail-secret\nerror: recent failure\n",
                encoding="utf-8",
            )

            with mock.patch.object(Path, "read_bytes", side_effect=AssertionError("full file read")):
                diagnostics = runner.remote_training_failure_diagnostics(root, 2)

        stderr = diagnostics["diagnostics"]["training-stderr.log"]
        self.assertGreater(stderr["bytes"], runner.DIAGNOSTIC_FILE_TAIL_BYTES)
        self.assertIn("error: recent failure", stderr["tail"])
        self.assertIn("GITHUB_TOKEN=[REDACTED]", stderr["tail"])
        self.assertNotIn("tail-secret", stderr["tail"])
        self.assertNotIn("old failure marker", stderr["tail"])

    def test_remote_training_failure_diagnostics_summarizes_repetition_progress(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            remote = root / "remote"
            remote.mkdir()
            for filename in runner.REMOTE_TRAINING_DIAGNOSTIC_FILES:
                (remote / filename).write_text("", encoding="utf-8")
            simulator_root = remote / "simulator-artifacts"
            for run_id, successful, failed, ticks, seconds in (
                ("run-test-r01", 5, 0, 10000, 640.25),
                ("run-test-r02", 4, 1, 9600, 690.5),
            ):
                run_dir = simulator_root / run_id
                run_dir.mkdir(parents=True)
                (run_dir / "run_summary.json").write_text(
                    json.dumps({
                        "runId": run_id,
                        "ok": failed == 0,
                        "successful": successful,
                        "failed": failed,
                        "total_environments": successful + failed,
                        "total_ticks": ticks,
                        "wallClockSeconds": seconds,
                        "variants": [{} for _ in range(successful + failed)],
                    }),
                    encoding="utf-8",
                )

            diagnostics = runner.remote_training_failure_diagnostics(
                root,
                runner.PROCESS_TIMEOUT_RETURN_CODE,
                run_id="run-test",
                controller_timed_out=True,
            )

        self.assertEqual(diagnostics["failureClass"], "remote_training_timeout")
        self.assertIn(
            "simulator-artifacts/run-test-r01/run_summary.json",
            diagnostics["diagnostics"],
        )
        progress = diagnostics["partialSimulatorProgress"]
        self.assertEqual(progress["runSummaryCount"], 2)
        self.assertEqual(progress["completedEnvironmentRows"], 10)
        self.assertEqual(progress["successfulEnvironmentRows"], 9)
        self.assertEqual(progress["failedEnvironmentRows"], 1)
        self.assertEqual(progress["ticksRun"], 19600)
        self.assertEqual(progress["wallClockSeconds"], 1330.75)

    def test_remote_training_partial_progress_counts_terminal_rows_not_planned_total(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_dir = root / "remote" / "simulator-artifacts" / "run-test"
            run_dir.mkdir(parents=True)
            (run_dir / "run_summary.json").write_text(
                json.dumps({
                    "runId": "run-test",
                    "ok": False,
                    "successful": 2,
                    "failed": 1,
                    "total_environments": 5,
                    "total_ticks": 1234,
                    "wallClockSeconds": 12.3456,
                    "variants": [{}, {}, {}, {}, {}],
                }),
                encoding="utf-8",
            )

            progress = runner.remote_training_partial_simulator_progress(root, "run-test")

        self.assertIsNotNone(progress)
        assert progress is not None
        self.assertEqual(progress["completedEnvironmentRows"], 3)
        self.assertEqual(progress["successfulEnvironmentRows"], 2)
        self.assertEqual(progress["failedEnvironmentRows"], 1)
        self.assertEqual(progress["runSummaries"][0]["totalEnvironments"], 5)
        self.assertEqual(progress["runSummaries"][0]["wallClockSeconds"], 12.346)

        execution = runner.controller_execution_summary(
            controller_args(),
            steps=[],
            result={"remoteTrainingFailure": {"partialSimulatorProgress": progress}},
            scaled_up=False,
            instance_id=None,
        )
        self.assertEqual(execution["environmentsRun"], 3)

    def test_remote_training_partial_progress_normalizes_non_finite_wall_clock_seconds(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            simulator_root = root / "remote" / "simulator-artifacts"
            for run_id, seconds in (("run-test-r01", float("nan")), ("run-test-r02", float("inf"))):
                run_dir = simulator_root / run_id
                run_dir.mkdir(parents=True)
                (run_dir / "run_summary.json").write_text(
                    json.dumps({
                        "runId": run_id,
                        "ok": True,
                        "successful": 1,
                        "failed": 0,
                        "total_environments": 1,
                        "total_ticks": 100,
                        "wallClockSeconds": seconds,
                    }),
                    encoding="utf-8",
                )

            progress = runner.remote_training_partial_simulator_progress(root, "run-test")

        self.assertIsNotNone(progress)
        assert progress is not None
        self.assertEqual(progress["wallClockSeconds"], 0.0)
        self.assertEqual([summary["wallClockSeconds"] for summary in progress["runSummaries"]], [0.0, 0.0])
        self.assertEqual(progress["completedEnvironmentRows"], 2)
        encoded = runner.canonical_json({"partialSimulatorProgress": progress})
        self.assertNotIn("NaN", encoded)
        self.assertNotIn("Infinity", encoded)

    def test_canonical_json_rejects_non_finite_numbers(self) -> None:
        with self.assertRaises(ValueError):
            runner.canonical_json({"wallClockSeconds": float("nan")})

    def test_controller_execution_summary_uses_partial_timeout_progress_when_no_report(self) -> None:
        args = controller_args()
        result = {
            "remoteTrainingFailure": {
                "failureClass": "remote_training_timeout",
                "partialSimulatorProgress": {
                    "completedEnvironmentRows": 10,
                },
            }
        }

        execution = runner.controller_execution_summary(
            args,
            steps=[],
            result=result,
            scaled_up=False,
            instance_id=None,
        )

        self.assertEqual(execution["environmentsRun"], 10)
        self.assertFalse(execution["trainingReportProduced"])

    def test_collect_remote_artifacts_tolerates_missing_partial_diagnostics(self) -> None:
        args = controller_args()
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=root)
            scripts: list[str] = []

            def fake_ssh_cmd(name: str, remote_command: str, **_kwargs: object) -> subprocess.CompletedProcess[str]:
                if name == "pack_remote_artifacts":
                    scripts.append(decode_remote_bash_lc(remote_command))
                return subprocess.CompletedProcess(["ssh"], 0, "", "")

            with (
                mock.patch.object(controller, "ssh_cmd", side_effect=fake_ssh_cmd),
                mock.patch.object(
                    controller,
                    "scp_from_worker",
                    side_effect=runner.BatchRunError("stop after pack"),
                ),
            ):
                with self.assertRaisesRegex(runner.BatchRunError, "stop after pack"):
                    controller.collect_remote_artifacts()

        self.assertEqual(len(scripts), 1)
        self.assertIn("mkdir -p repo/runtime-artifacts/rl-training", scripts[0])
        self.assertIn(
            "touch card-validation.json training-summary.json training-stderr.log report-extract.json",
            scripts[0],
        )
        self.assertIn(
            "for simulator_file in run_summary.json resource_guard_failure.json setup_failure.json run_failure.json owned_room_scorecard.json",
            scripts[0],
        )
        self.assertIn(
            'for simulator_dir in "simulator-artifacts/$RUN_ID" "simulator-artifacts/$RUN_ID-pre-scale-smoke" "simulator-artifacts/$RUN_ID"-r*',
            scripts[0],
        )

    def test_generate_experiment_card_passes_multi_tier_scenario_request(self) -> None:
        args = controller_args()
        args.training_approach = "policy_gradient"
        args.workers = 5
        args.scenario_id = runner.MULTI_TIER_SCENARIO_ID
        args.require_multi_tier_scenario = True
        observed_cmds: list[list[str]] = []
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=root)

            def fake_run_cp(name: str, cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                observed_cmds.append(cmd)
                if name == "generate_experiment_card":
                    output = Path(cmd[cmd.index("--output") + 1])
                    payload = card_helper.build_card(
                        dataset_run_id="dataset-test",
                        code_commit="a" * 40,
                        training_approach="policy_gradient",
                        created_at="2026-05-18T10:18:00Z",
                        scenario_id=runner.MULTI_TIER_SCENARIO_ID,
                        require_multi_tier_scenario=True,
                    )
                    output.write_text(json.dumps(payload), encoding="utf-8")
                return subprocess.CompletedProcess(cmd, 0, "{}", "")

            with mock.patch.object(controller, "run_cp", side_effect=fake_run_cp):
                controller.generate_experiment_card()

            card = json.loads((root / "experiment_card.json").read_text(encoding="utf-8"))
            spec = json.loads((root / "scale_proof_spec.json").read_text(encoding="utf-8"))

        generate_cmd = observed_cmds[0]
        self.assertEqual(generate_cmd[generate_cmd.index("--scenario-id") + 1], runner.MULTI_TIER_SCENARIO_ID)
        self.assertIn("--require-multi-tier-scenario", generate_cmd)
        self.assertEqual(card["scenario"]["scenario_id"], runner.MULTI_TIER_SCENARIO_ID)
        self.assertEqual(card["policy_gradient"]["policy_update"]["algorithm"], "reinforce_v1")
        self.assertEqual(card["policy_gradient"]["policy_update"]["learning_rate"], 1)
        self.assertTrue(card["scenario"]["capabilities"]["hostile_combat_signal"])
        self.assertEqual(card["scenario"]["evidence"]["adjacent_room"], "E2S1")
        self.assertEqual(card["scenario"]["evidence"]["neutral_expansion_room_count"], 2)
        self.assertEqual(card["scenario"]["evidence"]["hostile_creep_count"], 3)
        self.assertEqual(card["scenario"]["evidence"]["hostile_spawn_count"], 1)
        self.assertEqual(card["scenario"]["evidence"]["hostile_tower_count"], 1)
        self.assertEqual(card["simulation"]["map_source_file"], runner.MULTI_TIER_SIMULATION_MAP_SOURCE_REL)
        self.assertEqual(card["scenario"]["evidence"]["map_source_file"], runner.MULTI_TIER_SIMULATION_MAP_SOURCE_REL)
        self.assertEqual(spec["experimentCard"]["scenario"]["scenario_id"], runner.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(spec["scaleProof"]["remoteRunnerContract"]["requireMultiTierScenario"])
        self.assertEqual(
            spec["scaleProof"]["remoteRunnerContract"]["cardSimulationFields"]["map_source_file"],
            runner.MULTI_TIER_SIMULATION_MAP_SOURCE_REL,
        )
        self.assertEqual(
            spec["scaleProof"]["remoteRunnerContract"]["cardSimulationFields"]["fixtureEvidence"]["hostileSpawnCount"],
            1,
        )
        self.assertEqual(
            spec["scaleProof"]["remoteRunnerContract"]["cardSimulationFields"]["fixtureEvidence"]["neutralExpansionRoomCount"],
            2,
        )
        self.assertFalse(card["safety"]["officialMmoWritesAllowed"])

    def test_verify_remote_training_report_requires_scale_proof_success_for_workers_five(self) -> None:
        args = controller_args()
        args.workers = 5
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(
                json.dumps(
                    {
                        "reportId": "run-test",
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": False,
                        "artifactCount": 5,
                        "scaleValidation": {
                            "ok": False,
                            "totalEnvironments": 5,
                            "successfulEnvironments": 3,
                            "minimumSuccessfulEnvironments": 4,
                        },
                    }
                ),
                encoding="utf-8",
            )
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=root)

            with self.assertRaisesRegex(runner.BatchRunError, "scale proof success count"):
                controller.verify_remote_training_report()
            self.assertEqual(controller.result["trainingReport"]["artifactCount"], 5)
            self.assertEqual(
                controller.result["trainingReport"]["scaleValidation"]["successfulEnvironments"],
                3,
            )
            execution = runner.controller_execution_summary(args, controller.steps, controller.result, False, None)
            self.assertTrue(execution["trainingReportProduced"])
            self.assertEqual(execution["environmentsRun"], 5)

            data = json.loads(report.read_text(encoding="utf-8"))
            data["scaleValidation"]["ok"] = True
            data["scaleValidation"]["minimumSuccessfulEnvironments"] = 1
            report.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaisesRegex(runner.BatchRunError, "scale proof success count"):
                controller.verify_remote_training_report()

            data["scaleValidation"]["ok"] = True
            data["scaleValidation"]["successfulEnvironments"] = 4
            report.write_text(json.dumps(data), encoding="utf-8")
            controller.verify_remote_training_report()

        self.assertEqual(controller.result["trainingReport"]["scaleValidation"]["successfulEnvironments"], 4)

    def test_verify_remote_training_report_accepts_repeated_scale_proof_totals(self) -> None:
        args = controller_args()
        args.workers = 5
        args.repetitions = 5
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            data = {
                "reportId": "run-test",
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
                "artifactCount": 25,
                "scaleValidation": {
                    "ok": True,
                    "targetEnvironments": 5,
                    "minimumSuccessfulEnvironments": 4,
                    "totalEnvironments": 25,
                    "successfulEnvironments": 24,
                    "failedEnvironments": 1,
                    "repetitions": 5,
                },
            }
            report.write_text(json.dumps(data), encoding="utf-8")
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=root)

            controller.verify_remote_training_report()

            data["scaleValidation"]["ok"] = False
            data["scaleValidation"]["perRun"] = [
                {
                    "ok": False,
                    "runId": "run-test-r01",
                    "successfulEnvironments": 3,
                    "totalEnvironments": 5,
                }
            ]
            report.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaisesRegex(
                runner.BatchRunError,
                "perRunFailures=run-test-r01:3/5",
            ):
                controller.verify_remote_training_report()
            self.assertEqual(controller.result["trainingReport"]["artifactCount"], 25)
            self.assertEqual(controller.result["trainingReport"]["scaleValidation"]["successfulEnvironments"], 24)

            data["scaleValidation"]["ok"] = True
            data["scaleValidation"].pop("perRun")
            data["scaleValidation"]["totalEnvironments"] = 24
            report.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaisesRegex(runner.BatchRunError, "scale proof environment count"):
                controller.verify_remote_training_report()

        self.assertEqual(controller.result["trainingReport"]["scaleValidation"]["successfulEnvironments"], 24)

    def test_scale_proof_result_rejects_malformed_remote_counts(self) -> None:
        valid = {
            "ok": True,
            "totalEnvironments": 5,
            "successfulEnvironments": 4,
            "minimumSuccessfulEnvironments": 4,
        }
        runner.validate_scale_proof_result(valid, 5)

        cases = [
            (
                "inflated-total",
                {"totalEnvironments": 9, "successfulEnvironments": 9},
                "scale proof environment count",
            ),
            (
                "successes-above-total",
                {"successfulEnvironments": 6},
                "scale proof success count",
            ),
            (
                "minimum-above-total",
                {"minimumSuccessfulEnvironments": 6},
                "scale proof minimum success count",
            ),
            (
                "minimum-below-zero",
                {"minimumSuccessfulEnvironments": -1},
                "scale proof minimum success count",
            ),
        ]
        for name, updates, pattern in cases:
            with self.subTest(name=name):
                malformed = {**valid, **updates}
                with self.assertRaisesRegex(runner.BatchRunError, pattern):
                    runner.validate_scale_proof_result(malformed, 5)

    def test_prepare_worker_known_host_keeps_existing_entry_before_ssh_probe(self) -> None:
        current_key = "203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIcurrent"
        with tempfile.TemporaryDirectory() as temp_dir:
            args = controller_args()
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            known_hosts = Path(args.known_hosts_path)
            known_hosts.write_text(current_key + "\n", encoding="utf-8")
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            controller.public_ip = "203.0.113.10"

            with mock.patch.object(
                runner.subprocess,
                "run",
                return_value=subprocess.CompletedProcess(["ssh-keyscan"], 0, current_key + "\n", ""),
            ) as run:
                result = controller.prepare_worker_known_host()

            self.assertTrue(result.ok)
            self.assertEqual(result.status, "existing_known_host")
            self.assertEqual(known_hosts.read_text(encoding="utf-8"), current_key + "\n")
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.args[0][0], "ssh-keyscan")

        self.assertEqual([step.name for step in controller.steps], ["scan_worker_host_key", "prepare_worker_known_host"])
        self.assertIn("203.0.113.10", controller.known_hosts_prepared_public_ips)

    def test_prepare_worker_known_host_rotates_stale_entry_before_ssh_probe(self) -> None:
        stale_key = "203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIstale"
        current_key = "203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIcurrent"
        with tempfile.TemporaryDirectory() as temp_dir:
            args = controller_args()
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            known_hosts = Path(args.known_hosts_path)
            known_hosts.write_text(stale_key + "\n", encoding="utf-8")
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            controller.public_ip = "203.0.113.10"

            def fake_run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                if cmd[0] == "ssh-keyscan":
                    return subprocess.CompletedProcess(cmd, 0, current_key + "\n", "")
                if cmd[0] == "ssh-keygen":
                    known_hosts.write_text("", encoding="utf-8")
                    stdout = "# Host 203.0.113.10 found: line 1\nknown_hosts updated.\n"
                    return subprocess.CompletedProcess(cmd, 0, stdout, "")
                raise AssertionError(cmd)

            with mock.patch.object(runner.subprocess, "run", side_effect=fake_run):
                result = controller.prepare_worker_known_host()

            self.assertTrue(result.ok)
            self.assertEqual(result.status, "rotated_known_host")
            self.assertEqual(known_hosts.read_text(encoding="utf-8"), current_key + "\n")

        self.assertEqual([step.name for step in controller.steps], ["scan_worker_host_key", "install_worker_known_host"])
        self.assertEqual(controller.steps[-1].detail["status"], "rotated_known_host")
        self.assertIn("203.0.113.10", controller.known_hosts_prepared_public_ips)

    def test_prepare_worker_known_host_installs_new_worker_entry_before_ssh_probe(self) -> None:
        current_key = "203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIcurrent"
        with tempfile.TemporaryDirectory() as temp_dir:
            args = controller_args()
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            known_hosts = Path(args.known_hosts_path)
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            controller.public_ip = "203.0.113.10"

            def fake_run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                if cmd[0] == "ssh-keyscan":
                    return subprocess.CompletedProcess(cmd, 0, current_key + "\n", "")
                if cmd[0] == "ssh-keygen":
                    return subprocess.CompletedProcess(cmd, 0, "Host 203.0.113.10 not found\n", "")
                raise AssertionError(cmd)

            with mock.patch.object(runner.subprocess, "run", side_effect=fake_run):
                result = controller.prepare_worker_known_host()

            self.assertTrue(result.ok)
            self.assertEqual(result.status, "new_known_host")
            self.assertEqual(known_hosts.read_text(encoding="utf-8"), current_key + "\n")

        self.assertEqual([step.name for step in controller.steps], ["scan_worker_host_key", "install_worker_known_host"])
        self.assertEqual(controller.steps[-1].detail["status"], "new_known_host")
        self.assertIn("203.0.113.10", controller.known_hosts_prepared_public_ips)

    def test_prepare_worker_known_host_retries_empty_keyscan_before_installing_key(self) -> None:
        current_key = "203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIcurrent"
        with tempfile.TemporaryDirectory() as temp_dir:
            args = controller_args()
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            known_hosts = Path(args.known_hosts_path)
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            controller.public_ip = "203.0.113.10"
            keyscan_calls = 0

            def fake_run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                nonlocal keyscan_calls
                if cmd[0] == "ssh-keyscan":
                    keyscan_calls += 1
                    if keyscan_calls < 3:
                        return subprocess.CompletedProcess(cmd, 1, "", "")
                    return subprocess.CompletedProcess(cmd, 0, current_key + "\n", "")
                if cmd[0] == "ssh-keygen":
                    return subprocess.CompletedProcess(cmd, 0, "Host 203.0.113.10 not found\n", "")
                raise AssertionError(cmd)

            with (
                mock.patch.object(runner.subprocess, "run", side_effect=fake_run),
                mock.patch.object(runner.time, "sleep", return_value=None) as sleep,
            ):
                result = controller.prepare_worker_known_host()

            self.assertTrue(result.ok)
            self.assertEqual(result.status, "new_known_host")
            self.assertEqual(known_hosts.read_text(encoding="utf-8"), current_key + "\n")

        self.assertEqual(keyscan_calls, 3)
        sleep.assert_has_calls([mock.call(2.0), mock.call(5.0)])
        scan_steps = [step for step in controller.steps if step.name == "scan_worker_host_key"]
        self.assertEqual([step.detail["attempt"] for step in scan_steps], [1, 2, 3])
        self.assertEqual([step.detail["status"] for step in scan_steps[:2]], ["host_key_scan_unavailable"] * 2)
        self.assertTrue(all(step.detail["retryable"] for step in scan_steps[:2]))
        self.assertEqual(controller.steps[-1].detail["status"], "new_known_host")
        self.assertIn("203.0.113.10", controller.known_hosts_prepared_public_ips)

    def test_prepare_worker_known_host_preserves_existing_entry_when_keyscan_unavailable(self) -> None:
        existing_key = "203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexisting"
        with tempfile.TemporaryDirectory() as temp_dir:
            args = controller_args()
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            known_hosts = Path(args.known_hosts_path)
            known_hosts.write_text(existing_key + "\n", encoding="utf-8")
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            controller.public_ip = "203.0.113.10"
            keyscan_calls = 0

            def fake_run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                nonlocal keyscan_calls
                if cmd[0] == "ssh-keyscan":
                    keyscan_calls += 1
                    return subprocess.CompletedProcess(cmd, 1, "", "")
                if cmd[0] == "ssh-keygen":
                    raise AssertionError("existing known_hosts entry should not be removed before strict SSH")
                raise AssertionError(cmd)

            with (
                mock.patch.object(runner.subprocess, "run", side_effect=fake_run),
                mock.patch.object(runner.time, "sleep", return_value=None) as sleep,
            ):
                result = controller.prepare_worker_known_host()

            self.assertTrue(result.ok)
            self.assertEqual(result.status, "existing_known_host_keyscan_unavailable")
            self.assertEqual(known_hosts.read_text(encoding="utf-8"), existing_key + "\n")

        self.assertEqual(keyscan_calls, 3)
        sleep.assert_has_calls([mock.call(2.0), mock.call(5.0)])
        self.assertEqual(
            [step.name for step in controller.steps],
            [
                "scan_worker_host_key",
                "scan_worker_host_key",
                "scan_worker_host_key",
                "prepare_worker_known_host",
            ],
        )
        self.assertEqual(controller.steps[-1].detail["status"], "existing_known_host_keyscan_unavailable")
        self.assertEqual(controller.steps[-1].detail["keyscanStatus"], "host_key_scan_unavailable")
        self.assertEqual(controller.steps[-1].detail["hostKeyCount"], 1)
        self.assertIn("203.0.113.10", controller.known_hosts_prepared_public_ips)

    def test_ssh_cmd_preserves_existing_entry_then_self_heals_strict_mismatch(self) -> None:
        stale_key = "203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIstale"
        current_key = "203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIcurrent"
        with tempfile.TemporaryDirectory() as temp_dir:
            args = controller_args()
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            known_hosts = Path(args.known_hosts_path)
            known_hosts.write_text(stale_key + "\n", encoding="utf-8")
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            controller.public_ip = "203.0.113.10"
            keyscan_calls = 0
            operation_commands: list[list[str]] = []

            def fake_run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                nonlocal keyscan_calls
                if cmd[0] == "ssh-keyscan":
                    keyscan_calls += 1
                    if keyscan_calls <= 3:
                        return subprocess.CompletedProcess(cmd, 1, "", "")
                    return subprocess.CompletedProcess(cmd, 0, current_key + "\n", "")
                if cmd[0] == "ssh-keygen":
                    known_hosts.write_text("", encoding="utf-8")
                    return subprocess.CompletedProcess(cmd, 0, "# Host 203.0.113.10 found: line 1\nknown_hosts updated.\n", "")
                raise AssertionError(cmd)

            def fake_run_cp(
                name: str,
                cmd: list[str],
                *,
                check: bool = True,
                timeout: int | None = None,
                cwd: Path | None = None,
                input_text: str | None = None,
                env: dict[str, str] | None = None,
            ) -> subprocess.CompletedProcess[str]:
                self.assertEqual(name, "ssh_probe")
                self.assertIs(check, False)
                operation_commands.append(cmd)
                if len(operation_commands) == 1:
                    stderr = "REMOTE HOST IDENTIFICATION HAS CHANGED!\nOffending ED25519 key in known_hosts:1\n"
                    return subprocess.CompletedProcess(cmd, 255, "", stderr)
                return subprocess.CompletedProcess(cmd, 0, "ok\n", "")

            with (
                mock.patch.object(controller, "run_cp", side_effect=fake_run_cp),
                mock.patch.object(runner.subprocess, "run", side_effect=fake_run),
                mock.patch.object(runner.time, "sleep", return_value=None),
            ):
                cp = controller.ssh_cmd("ssh_probe", "true")

            self.assertEqual(cp.returncode, 0)
            self.assertEqual(known_hosts.read_text(encoding="utf-8"), current_key + "\n")

        self.assertEqual(keyscan_calls, 4)
        self.assertEqual([cmd[0] for cmd in operation_commands], ["ssh", "ssh"])
        for cmd in operation_commands:
            with self.subTest(command=cmd):
                self.assertIn("StrictHostKeyChecking=yes", cmd)
                self.assertIn(f"UserKnownHostsFile={args.known_hosts_path}", cmd)
                self.assertNotIn("StrictHostKeyChecking=no", cmd)
                self.assertNotIn("StrictHostKeyChecking=accept-new", cmd)
        self.assertEqual(
            [step.name for step in controller.steps],
            [
                "scan_worker_host_key",
                "scan_worker_host_key",
                "scan_worker_host_key",
                "prepare_worker_known_host",
                "clear_worker_known_host",
                "scan_worker_host_key",
                "install_worker_known_host",
            ],
        )
        self.assertEqual(controller.steps[3].detail["status"], "existing_known_host_keyscan_unavailable")
        self.assertEqual(controller.steps[-1].detail["status"], "rotated_known_host")
        self.assertIn("203.0.113.10", controller.known_hosts_prepared_public_ips)

    def test_prepare_worker_known_host_accept_new_fallback_after_empty_keyscan_attempts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            args = controller_args()
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            known_hosts = Path(args.known_hosts_path)
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            controller.public_ip = "203.0.113.10"
            commands: list[list[str]] = []

            def fake_run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                commands.append(cmd)
                if cmd[0] == "ssh-keyscan":
                    return subprocess.CompletedProcess(cmd, 1, "", "")
                if cmd[0] == "ssh-keygen":
                    known_hosts.write_text("", encoding="utf-8")
                    return subprocess.CompletedProcess(cmd, 0, "Host 203.0.113.10 not found\n", "")
                if cmd[0] == "ssh":
                    known_hosts.write_text(
                        "203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIaccepted\n",
                        encoding="utf-8",
                    )
                    return subprocess.CompletedProcess(cmd, 0, "", "Warning: Permanently added host.\n")
                raise AssertionError(cmd)

            with (
                mock.patch.object(runner.subprocess, "run", side_effect=fake_run),
                mock.patch.object(runner.time, "sleep", return_value=None) as sleep,
            ):
                result = controller.prepare_worker_known_host()

            self.assertTrue(result.ok)
            self.assertEqual(result.status, "accepted_new_known_host")

        sleep.assert_has_calls([mock.call(2.0), mock.call(5.0)])
        self.assertEqual(
            [step.name for step in controller.steps],
            [
                "scan_worker_host_key",
                "scan_worker_host_key",
                "scan_worker_host_key",
                "clear_worker_known_host",
                "accept_new_worker_known_host",
            ],
        )
        self.assertTrue(all(step.detail["retryable"] for step in controller.steps[:3]))
        ssh_commands = [cmd for cmd in commands if cmd[0] == "ssh"]
        self.assertEqual(len(ssh_commands), 1)
        self.assertIn("StrictHostKeyChecking=accept-new", ssh_commands[0])
        self.assertIn(f"UserKnownHostsFile={args.known_hosts_path}", ssh_commands[0])
        self.assertNotIn("StrictHostKeyChecking=no", ssh_commands[0])
        self.assertEqual(controller.steps[-1].detail["status"], "accepted_new_known_host")
        self.assertIn("203.0.113.10", controller.known_hosts_prepared_public_ips)

    def test_prepare_worker_known_host_failure_is_not_reported_as_network_unreachable(self) -> None:
        current_key = "203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIcurrent"
        with tempfile.TemporaryDirectory() as temp_dir:
            args = controller_args()
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            controller.public_ip = "203.0.113.10"

            def fake_run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                if cmd[0] == "ssh-keyscan":
                    return subprocess.CompletedProcess(cmd, 0, current_key + "\n", "")
                if cmd[0] == "ssh-keygen":
                    return subprocess.CompletedProcess(cmd, 13, "", "permission denied\n")
                raise AssertionError(cmd)

            with mock.patch.object(runner.subprocess, "run", side_effect=fake_run):
                result = controller.prepare_worker_known_host()

        self.assertFalse(result.ok)
        self.assertFalse(result.retryable)
        self.assertEqual(result.status, "host_key_self_healing_failed")
        self.assertEqual(controller.steps[-1].detail["status"], "host_key_self_healing_failed")
        self.assertIn("SSH known_hosts self-healing failed", runner.ssh_prepare_failure_message("ssh_probe", result))
        self.assertNotIn("network unreachable", runner.ssh_prepare_failure_message("ssh_probe", result))

    def test_wait_for_ssh_reports_unreachable_worker_without_host_key_self_heal_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            args = controller_args()
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            controller.public_ip = "203.0.113.10"

            def fake_run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                stderr = "connect to address 203.0.113.10 port 22: Connection refused\n"
                return subprocess.CompletedProcess(cmd, 1, "", stderr)

            with (
                mock.patch.object(runner.subprocess, "run", side_effect=fake_run),
                mock.patch.object(runner.time, "time", side_effect=[100.0, 101.0, 102.0, 103.0, 600.0]),
                mock.patch.object(runner.time, "sleep", return_value=None),
            ):
                reachable = controller.wait_for_ssh()

        self.assertFalse(reachable)
        self.assertEqual([step.name for step in controller.steps], ["scan_worker_host_key", "ssh_probe"])
        self.assertEqual(controller.steps[0].detail["status"], "network_unreachable")
        self.assertTrue(controller.steps[0].detail["retryable"])
        self.assertEqual(controller.steps[1].detail["sshFailureClass"], "network_unreachable")
        self.assertNotIn("203.0.113.10", controller.known_hosts_prepared_public_ips)

    def test_clear_known_host_skips_when_public_ip_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=Path(temp_dir))
            with mock.patch.object(runner.subprocess, "run") as run:
                controller.clear_worker_known_host()

        run.assert_not_called()
        self.assertFalse([step for step in controller.steps if step.name == "clear_worker_known_host"])

    def test_ssh_and_scp_commands_prepare_and_use_consistent_known_hosts_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            args = controller_args()
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            parsed = runner.parse_cli_args(["preflight", "--known-hosts-path", args.known_hosts_path])
            self.assertEqual(parsed.known_hosts_path, args.known_hosts_path)
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            controller.public_ip = "203.0.113.10"
            controller.known_hosts_prepared_public_ips.add("203.0.113.10")
            commands: list[list[str]] = []

            def capture_run_cp(
                name: str,
                cmd: list[str],
                *,
                check: bool = True,
                timeout: int | None = None,
                cwd: Path | None = None,
                input_text: str | None = None,
                env: dict[str, str] | None = None,
            ) -> subprocess.CompletedProcess[str]:
                commands.append(cmd)
                return subprocess.CompletedProcess(cmd, 0, "", "")

            with mock.patch.object(controller, "run_cp", side_effect=capture_run_cp):
                controller.ssh_cmd("ssh_probe", "true")
                controller.scp_to_worker("upload", Path(temp_dir) / "local.txt", "/remote/local.txt")
                controller.scp_from_worker("download", "/remote/out.txt", Path(temp_dir) / "out" / "out.txt")

        self.assertEqual(len(commands), 3)
        for cmd in commands:
            with self.subTest(command=cmd[0]):
                self.assertIn("BatchMode=yes", cmd)
                self.assertIn("StrictHostKeyChecking=yes", cmd)
                self.assertIn(f"UserKnownHostsFile={args.known_hosts_path}", cmd)

    def test_ssh_cmd_self_heals_mismatched_known_host_then_retries_strictly(self) -> None:
        stale_key = "203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIstale"
        current_key = "203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIcurrent"
        with tempfile.TemporaryDirectory() as temp_dir:
            args = controller_args()
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            known_hosts = Path(args.known_hosts_path)
            known_hosts.write_text(stale_key + "\n", encoding="utf-8")
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            controller.public_ip = "203.0.113.10"
            controller.known_hosts_prepared_public_ips.add("203.0.113.10")
            keyscan_calls = 0
            operation_commands: list[list[str]] = []

            def fake_run_cp(
                name: str,
                cmd: list[str],
                *,
                check: bool = True,
                timeout: int | None = None,
                cwd: Path | None = None,
                input_text: str | None = None,
                env: dict[str, str] | None = None,
            ) -> subprocess.CompletedProcess[str]:
                self.assertIs(check, False)
                operation_commands.append(cmd)
                if len(operation_commands) == 1:
                    stderr = "REMOTE HOST IDENTIFICATION HAS CHANGED!\nOffending ED25519 key in known_hosts:1\n"
                    return subprocess.CompletedProcess(cmd, 255, "", stderr)
                return subprocess.CompletedProcess(cmd, 0, "ok\n", "")

            def fake_run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                nonlocal keyscan_calls
                if cmd[0] == "ssh-keygen":
                    known_hosts.write_text("", encoding="utf-8")
                    return subprocess.CompletedProcess(cmd, 0, "# Host 203.0.113.10 found: line 1\nknown_hosts updated.\n", "")
                if cmd[0] == "ssh-keyscan":
                    keyscan_calls += 1
                    if keyscan_calls < 3:
                        return subprocess.CompletedProcess(cmd, 1, "", "")
                    return subprocess.CompletedProcess(cmd, 0, current_key + "\n", "")
                raise AssertionError(cmd)

            with (
                mock.patch.object(controller, "run_cp", side_effect=fake_run_cp),
                mock.patch.object(runner.subprocess, "run", side_effect=fake_run),
                mock.patch.object(runner.time, "sleep", return_value=None) as sleep,
            ):
                cp = controller.ssh_cmd("ssh_probe", "true")

            self.assertEqual(cp.returncode, 0)
            self.assertEqual(known_hosts.read_text(encoding="utf-8"), current_key + "\n")

        self.assertEqual(keyscan_calls, 3)
        sleep.assert_has_calls([mock.call(2.0), mock.call(5.0)])
        self.assertEqual([cmd[0] for cmd in operation_commands], ["ssh", "ssh"])
        for cmd in operation_commands:
            with self.subTest(command=cmd):
                self.assertIn("StrictHostKeyChecking=yes", cmd)
                self.assertIn(f"UserKnownHostsFile={args.known_hosts_path}", cmd)
                self.assertNotIn("StrictHostKeyChecking=no", cmd)
                self.assertNotIn("StrictHostKeyChecking=accept-new", cmd)
        self.assertEqual(
            [step.name for step in controller.steps],
            [
                "clear_worker_known_host",
                "scan_worker_host_key",
                "scan_worker_host_key",
                "scan_worker_host_key",
                "install_worker_known_host",
            ],
        )
        self.assertIn("203.0.113.10", controller.known_hosts_prepared_public_ips)

    def test_ssh_cmd_mismatch_blocks_accept_new_when_keyscan_unavailable(self) -> None:
        stale_key = "203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIstale"
        with tempfile.TemporaryDirectory() as temp_dir:
            args = controller_args()
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            known_hosts = Path(args.known_hosts_path)
            known_hosts.write_text(stale_key + "\n", encoding="utf-8")
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            controller.public_ip = "203.0.113.10"
            controller.known_hosts_prepared_public_ips.add("203.0.113.10")
            keyscan_calls = 0
            operation_commands: list[list[str]] = []

            def fake_run_cp(
                name: str,
                cmd: list[str],
                *,
                check: bool = True,
                timeout: int | None = None,
                cwd: Path | None = None,
                input_text: str | None = None,
                env: dict[str, str] | None = None,
            ) -> subprocess.CompletedProcess[str]:
                self.assertIs(check, False)
                operation_commands.append(cmd)
                stderr = "REMOTE HOST IDENTIFICATION HAS CHANGED!\nOffending ED25519 key in known_hosts:1\n"
                return subprocess.CompletedProcess(cmd, 255, "", stderr)

            def fake_run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                nonlocal keyscan_calls
                if cmd[0] == "ssh-keygen":
                    known_hosts.write_text("", encoding="utf-8")
                    return subprocess.CompletedProcess(cmd, 0, "# Host 203.0.113.10 found: line 1\nknown_hosts updated.\n", "")
                if cmd[0] == "ssh-keyscan":
                    keyscan_calls += 1
                    return subprocess.CompletedProcess(cmd, 1, "", "")
                raise AssertionError(cmd)

            with (
                mock.patch.object(controller, "run_cp", side_effect=fake_run_cp),
                mock.patch.object(runner.subprocess, "run", side_effect=fake_run),
                mock.patch.object(runner.time, "sleep", return_value=None) as sleep,
            ):
                cp = controller.ssh_cmd("ssh_probe", "true", check=False)

            self.assertEqual(cp.returncode, 255)
            self.assertIn("host_key_self_healing_unavailable", cp.stderr)
            self.assertIn("host-key mismatch remains blocked", cp.stderr)
            self.assertEqual(known_hosts.read_text(encoding="utf-8"), "")

        self.assertEqual(keyscan_calls, 3)
        sleep.assert_has_calls([mock.call(2.0), mock.call(5.0)])
        self.assertEqual([cmd[0] for cmd in operation_commands], ["ssh"])
        self.assertEqual(
            [step.name for step in controller.steps],
            [
                "clear_worker_known_host",
                "scan_worker_host_key",
                "scan_worker_host_key",
                "scan_worker_host_key",
                "ssh_probe",
            ],
        )
        self.assertEqual(controller.steps[-1].detail["sshFailureClass"], "host_key_self_healing_unavailable")
        self.assertFalse(controller.steps[-1].detail["retryable"])
        self.assertNotIn("203.0.113.10", controller.known_hosts_prepared_public_ips)

    def test_scp_to_worker_self_heals_mismatched_known_host_then_retries_strictly(self) -> None:
        stale_key = "203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIstale"
        current_key = "203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIcurrent"
        with tempfile.TemporaryDirectory() as temp_dir:
            args = controller_args()
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            known_hosts = Path(args.known_hosts_path)
            known_hosts.write_text(stale_key + "\n", encoding="utf-8")
            local_path = Path(temp_dir) / "local.txt"
            local_path.write_text("payload\n", encoding="utf-8")
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            controller.public_ip = "203.0.113.10"
            controller.known_hosts_prepared_public_ips.add("203.0.113.10")
            operation_commands: list[list[str]] = []

            def fake_run_cp(
                name: str,
                cmd: list[str],
                *,
                check: bool = True,
                timeout: int | None = None,
                cwd: Path | None = None,
                input_text: str | None = None,
                env: dict[str, str] | None = None,
            ) -> subprocess.CompletedProcess[str]:
                self.assertIs(check, False)
                operation_commands.append(cmd)
                if len(operation_commands) == 1:
                    return subprocess.CompletedProcess(cmd, 255, "", "Host key verification failed.\n")
                return subprocess.CompletedProcess(cmd, 0, "", "")

            def fake_run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                if cmd[0] == "ssh-keygen":
                    known_hosts.write_text("", encoding="utf-8")
                    return subprocess.CompletedProcess(cmd, 0, "# Host 203.0.113.10 found: line 1\nknown_hosts updated.\n", "")
                if cmd[0] == "ssh-keyscan":
                    return subprocess.CompletedProcess(cmd, 0, current_key + "\n", "")
                raise AssertionError(cmd)

            with (
                mock.patch.object(controller, "run_cp", side_effect=fake_run_cp),
                mock.patch.object(runner.subprocess, "run", side_effect=fake_run),
            ):
                controller.scp_to_worker("upload", local_path, "/remote/local.txt")

            self.assertEqual(known_hosts.read_text(encoding="utf-8"), current_key + "\n")

        self.assertEqual([cmd[0] for cmd in operation_commands], ["scp", "scp"])
        for cmd in operation_commands:
            with self.subTest(command=cmd):
                self.assertIn("StrictHostKeyChecking=yes", cmd)
                self.assertIn(f"UserKnownHostsFile={args.known_hosts_path}", cmd)
                self.assertNotIn("StrictHostKeyChecking=no", cmd)
                self.assertNotIn("StrictHostKeyChecking=accept-new", cmd)
        self.assertEqual(
            [step.name for step in controller.steps],
            ["clear_worker_known_host", "scan_worker_host_key", "install_worker_known_host"],
        )
        self.assertIn("203.0.113.10", controller.known_hosts_prepared_public_ips)

    def test_known_host_cleanup_warning_redacts_secret_and_host_key_output(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            args = controller_args()
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            controller.public_ip = "203.0.113.10"
            stdout = (
                "line=203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIhostkey comment\n"
                "line=203.0.113.10 ssh-rsa-cert-v01@openssh.com AAAAB3NzaC1yc2EtY2VydCcertkey comment\n"
                "STEAM_KEY=steam-secret\n"
            )
            stderr = (
                "TOKEN=token-secret\n"
                "ecdsa-sha2-nistp256-cert-v01@openssh.com AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYtY2VydCcertkey\n"
                "sk-ssh-ed25519-cert-v01@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5LWNlcnQcertkey\n"
            )

            with mock.patch.object(
                runner.subprocess,
                "run",
                return_value=subprocess.CompletedProcess(["ssh-keygen"], 255, stdout, stderr),
            ):
                controller.clear_worker_known_host()

            combined = json.dumps(
                {
                    "steps": [step.__dict__ for step in controller.steps],
                    "result": controller.result,
                },
                sort_keys=True,
            )

        self.assertIn("[REDACTED_HOST_KEY]", combined)
        self.assertIn("STEAM_KEY=[REDACTED]", combined)
        self.assertIn("TOKEN=[REDACTED]", combined)
        self.assertNotIn("AAAA", combined)
        self.assertNotIn("-cert-v01@openssh.com", combined)
        self.assertNotIn("steam-secret", combined)
        self.assertNotIn("token-secret", combined)

    def test_safe_extract_tar_rejects_traversal_and_special_entries(self) -> None:
        cases = [
            ("../escape", lambda tar: add_file(tar, "../escape")),
            ("/tmp/escape", lambda tar: add_file(tar, "/tmp/escape")),
            ("symlink", lambda tar: add_special(tar, "link", tarfile.SYMTYPE, "/tmp/escape")),
            ("hardlink", lambda tar: add_special(tar, "hard", tarfile.LNKTYPE, "/tmp/escape")),
            ("fifo", lambda tar: add_special(tar, "fifo", tarfile.FIFOTYPE)),
        ]
        for name, callback in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                tar_path = root / "remote-artifacts.tar.gz"
                write_tar(tar_path, callback)

                with self.assertRaises(runner.BatchRunError):
                    runner.safe_extract_tar(tar_path, root / "remote")

    def test_scale_down_raises_after_recording_failed_modify_desired_capacity(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=Path(temp_dir))

            with mock.patch.object(
                runner.subprocess,
                "run",
                return_value=subprocess.CompletedProcess(["tccli"], 1, "", "permission denied"),
            ):
                with self.assertRaisesRegex(runner.BatchRunError, "scale_down failed"):
                    controller.scale_down()

        self.assertEqual(controller.steps[-1].name, "scale_down")
        self.assertFalse(controller.steps[-1].ok)

    def test_scale_down_raises_after_recording_timeout_with_instances_present(self) -> None:
        args = controller_args()
        args.scale_down_timeout_seconds = 1
        with tempfile.TemporaryDirectory() as temp_dir:
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))

            with (
                mock.patch.object(
                    runner.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess(["tccli"], 0, "{}", ""),
                ),
                mock.patch.object(
                    controller,
                    "describe_asg_group_summary",
                    return_value={
                        "DesiredCapacity": 0,
                        "InstanceCount": 1,
                        "InServiceInstanceCount": 1,
                        "InActivityStatus": "IN_ACTIVITY",
                    },
                ),
                mock.patch.object(controller, "describe_asg_instances", return_value=[{"InstanceId": "ins-test"}]),
                mock.patch.object(runner.time, "time", side_effect=[100.0, 100.0, 100.0, 101.1]),
                mock.patch.object(runner.time, "sleep", return_value=None),
            ):
                with self.assertRaisesRegex(runner.BatchRunError, "scale_down timeout"):
                    controller.scale_down()

        self.assertEqual(controller.steps[-1].name, "scale_down")
        self.assertFalse(controller.steps[-1].ok)
        self.assertEqual(controller.steps[-1].detail["desiredCapacity"], 0)
        self.assertEqual(controller.result["scaleDownLastSeen"]["asgInstances"], [{"InstanceId": "ins-test"}])

    def test_scale_down_records_success_after_asg_reaches_zero(self) -> None:
        args = controller_args()
        args.scale_down_timeout_seconds = 1
        with tempfile.TemporaryDirectory() as temp_dir:
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))

            with (
                mock.patch.object(
                    runner.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess(["tccli"], 0, "{}", ""),
                ),
                mock.patch.object(
                    controller,
                    "describe_asg_group_summary",
                    return_value={
                        "DesiredCapacity": 0,
                        "InstanceCount": 0,
                        "InServiceInstanceCount": 0,
                        "InActivityStatus": "NOT_IN_ACTIVITY",
                    },
                ),
                mock.patch.object(controller, "describe_asg_instances", return_value=[]),
                mock.patch.object(runner.time, "time", side_effect=[100.0, 100.0, 100.0]),
            ):
                controller.scale_down()

        self.assertEqual(controller.steps[-1].name, "scale_down")
        self.assertTrue(controller.steps[-1].ok)

    def test_controller_run_marks_completed_scale_down_failed_when_cleanup_times_out(self) -> None:
        class FakeController(runner.Controller):
            def ensure_map_present(self) -> None:
                pass

            def ensure_dist_present(self) -> None:
                pass

            def run_billing_guard(self) -> None:
                pass

            def verify_security_group(self) -> None:
                pass

            def generate_experiment_card(self) -> None:
                pass

            def scale_up_and_wait(self) -> None:
                self.scaled_up = True

            def verify_worker_security(self) -> None:
                pass

            def bootstrap_worker(self) -> None:
                pass

            def transfer_repo_bundle(self) -> None:
                pass

            def transfer_secret_env(self) -> None:
                pass

            def run_remote_training(self) -> None:
                pass

            def collect_remote_artifacts(self) -> None:
                pass

            def verify_remote_training_report(self) -> None:
                pass

        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            args = controller_args()
            args.artifact_root = artifact_root
            controller = FakeController(args=args, run_id="run-test", artifact_dir=artifact_root / "run-test")
            with (
                mock.patch.object(runner, "validate_static_inputs", return_value=None),
                mock.patch.object(
                    runner.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess(["tccli"], 0, "{}", ""),
                ),
                mock.patch.object(
                    controller,
                    "describe_asg_group_summary",
                    return_value={
                        "DesiredCapacity": 0,
                        "InstanceCount": 1,
                        "InServiceInstanceCount": 1,
                        "InActivityStatus": "IN_ACTIVITY",
                    },
                ),
                mock.patch.object(controller, "describe_asg_instances", return_value=[{"InstanceId": "ins-test"}]),
                mock.patch.object(runner.time, "time", side_effect=[100.0, 100.0, 100.0, 100.0, 101.1]),
                mock.patch.object(runner.time, "sleep", return_value=None),
            ):
                controller.run()

            summary = json.loads((artifact_root / "run-test" / "controller-summary.json").read_text(encoding="utf-8"))
        self.assertEqual(controller.final_status, "completed_scale_down_failed")
        self.assertEqual(summary["finalStatus"], "completed_scale_down_failed")
        self.assertIn("scale_down timeout", controller.result["scaleDownError"])
        self.assertEqual(summary["steps"][-1]["name"], "scale_down")
        self.assertFalse(summary["steps"][-1]["ok"])

    def test_controller_run_scales_down_after_multi_worker_training_failure(self) -> None:
        class FakeController(runner.Controller):
            def ensure_map_present(self) -> None:
                pass

            def ensure_dist_present(self) -> None:
                pass

            def run_billing_guard(self) -> None:
                pass

            def verify_security_group(self) -> None:
                pass

            def generate_experiment_card(self) -> None:
                pass

            def scale_up_and_wait(self) -> None:
                self.scaled_up = True

            def verify_worker_security(self) -> None:
                pass

            def bootstrap_worker(self) -> None:
                pass

            def transfer_repo_bundle(self) -> None:
                pass

            def transfer_secret_env(self) -> None:
                pass

            def run_remote_training(self) -> None:
                raise runner.BatchRunError("training failed")

            def scale_down(self) -> None:
                self.record_step("scale_down", 100.0, True, desiredCapacity=0)

        args = controller_args()
        args.workers = 5
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            args.artifact_root = artifact_root
            controller = FakeController(args=args, run_id="run-test", artifact_dir=artifact_root / "run-test")
            with mock.patch.object(runner, "validate_static_inputs", return_value=None):
                with self.assertRaisesRegex(runner.BatchRunError, "training failed"):
                    controller.run()
            summary = json.loads((artifact_root / "run-test" / "controller-summary.json").read_text(encoding="utf-8"))

        self.assertEqual(controller.final_status, "failed")
        self.assertEqual(summary["finalStatus"], "failed")
        self.assertTrue(summary["safety"]["scaleDownAttempted"])
        self.assertEqual(summary["steps"][-1]["name"], "scale_down")
        self.assertEqual(summary["steps"][-1]["detail"]["desiredCapacity"], 0)

    def test_controller_run_preserves_scale_failed_remote_report_evidence(self) -> None:
        class FakeController(runner.Controller):
            def check_pre_launch_guard(self) -> bool:
                return False

            def ensure_map_present(self) -> None:
                pass

            def ensure_dist_present(self) -> None:
                pass

            def run_billing_guard(self) -> None:
                pass

            def verify_security_group(self) -> None:
                pass

            def generate_experiment_card(self) -> None:
                pass

            def scale_up_and_wait(self) -> None:
                self.scaled_up = True
                self.instance_id = "ins-test"

            def verify_worker_security(self) -> None:
                pass

            def bootstrap_worker(self) -> None:
                pass

            def transfer_repo_bundle(self) -> None:
                pass

            def transfer_secret_env(self) -> None:
                pass

            def run_remote_training(self) -> None:
                self.record_step("remote_training", 100.0, True, reportId=self.run_id)

            def collect_remote_artifacts(self) -> None:
                report = runner.remote_training_report_path(self.artifact_dir, self.run_id)
                report.parent.mkdir(parents=True, exist_ok=True)
                report.write_text(
                    json.dumps(
                        {
                            "reportId": self.run_id,
                            "generatedAt": "2026-05-24T22:25:05Z",
                            "liveEffect": False,
                            "officialMmoWrites": False,
                            "officialMmoWritesAllowed": False,
                            "artifactCount": 23,
                            "simulation": {"ticks": runner.POLICY_GRADIENT_MIN_SIMULATION_TICKS},
                            "scaleValidation": {
                                "ok": False,
                                "targetEnvironments": 5,
                                "minimumSuccessfulEnvironments": 4,
                                "totalEnvironments": 25,
                                "successfulEnvironments": 23,
                                "failedEnvironments": 2,
                                "repetitions": 5,
                            },
                        }
                    ),
                    encoding="utf-8",
                )

            def scale_down(self) -> None:
                self.record_step("scale_down", 101.0, True, desiredCapacity=0)

        args = controller_args()
        args.training_approach = "policy_gradient"
        args.ticks = 500
        args.workers = 5
        args.repetitions = 5
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            args.artifact_root = artifact_root
            expected_training_report_path = runner.remote_training_report_path(
                artifact_root / "tencent-pg-20260524t222505z",
                "tencent-pg-20260524t222505z",
            )
            controller = FakeController(
                args=args,
                run_id="tencent-pg-20260524t222505z",
                artifact_dir=artifact_root / "tencent-pg-20260524t222505z",
            )
            with mock.patch.object(runner, "validate_static_inputs", return_value=None):
                with self.assertRaisesRegex(runner.BatchRunError, "scale proof did not satisfy success criteria"):
                    controller.run()
            summary = json.loads(
                (artifact_root / "tencent-pg-20260524t222505z" / "controller-summary.json").read_text(
                    encoding="utf-8",
                )
            )

        training_report = summary["outputs"]["trainingReport"]
        scale_validation = training_report["scaleValidation"]
        training_report_path = training_report["path"]
        execution_training_report_path = summary["execution"]["trainingReportPath"]
        self.assertEqual(summary["finalStatus"], "failed")
        self.assertIsInstance(training_report_path, str)
        self.assertTrue(training_report_path)
        self.assertIsInstance(execution_training_report_path, str)
        self.assertTrue(execution_training_report_path)
        self.assertEqual(training_report_path, execution_training_report_path)
        self.assertEqual(Path(training_report_path), expected_training_report_path)
        self.assertEqual(Path(execution_training_report_path), expected_training_report_path)
        self.assertTrue(summary["execution"]["trainingReportProduced"])
        self.assertEqual(summary["execution"]["trainingReportId"], "tencent-pg-20260524t222505z")
        self.assertEqual(summary["execution"]["artifactCount"], 23)
        self.assertEqual(summary["execution"]["environmentsRun"], 25)
        self.assertEqual(training_report["reportId"], "tencent-pg-20260524t222505z")
        self.assertEqual(training_report["artifactCount"], 23)
        self.assertFalse(scale_validation["ok"])
        self.assertEqual(scale_validation["targetEnvironments"], 5)
        self.assertEqual(scale_validation["totalEnvironments"], 25)
        self.assertEqual(scale_validation["successfulEnvironments"], 23)
        self.assertEqual(scale_validation["minimumSuccessfulEnvironments"], 4)
        self.assertEqual(scale_validation["repetitions"], 5)
        self.assertFalse(summary["safety"]["liveEffect"])
        self.assertFalse(summary["safety"]["officialMmoWrites"])
        self.assertFalse(summary["safety"]["officialMmoWritesAllowed"])
        self.assertFalse(summary["safety"]["secretsPrinted"])
        self.assertTrue(summary["safety"]["scaleDownAttempted"])
        self.assertEqual(summary["steps"][-1]["name"], "scale_down")
        self.assertEqual(summary["steps"][-1]["detail"]["desiredCapacity"], 0)

    def test_main_exits_nonzero_when_controller_cleanup_failed(self) -> None:
        class FakeController:
            def __init__(self, args: argparse.Namespace, run_id: str, artifact_dir: Path) -> None:
                self.args = args
                self.run_id = run_id
                self.artifact_dir = artifact_dir
                self.final_status = "unknown"

            def run(self) -> None:
                self.final_status = "completed_scale_down_failed"

        stdout = io.StringIO()
        stderr = io.StringIO()
        with (
            tempfile.TemporaryDirectory() as temp_dir,
            mock.patch.object(runner, "Controller", FakeController),
            mock.patch.object(runner.sys, "stdout", stdout),
            mock.patch.object(runner.sys, "stderr", stderr),
        ):
            exit_code = runner.main(["run-single", "--run-id", "run-test", "--artifact-root", temp_dir])

        self.assertNotEqual(exit_code, 0)
        self.assertEqual(stdout.getvalue(), "")
        self.assertNotIn('"ok": true', stderr.getvalue())
        payload = json.loads(stderr.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["status"], "completed_scale_down_failed")

    def test_main_exits_nonzero_when_paid_failure_recurrence_guard_blocks(self) -> None:
        class FakeController:
            def __init__(self, args: argparse.Namespace, run_id: str, artifact_dir: Path) -> None:
                self.args = args
                self.run_id = run_id
                self.artifact_dir = artifact_dir
                self.final_status = "unknown"
                self.result = {"launchGuard": {"status": "blocked", "activeGuard": "paid_failure_recurrence_guard"}}

            def run(self) -> None:
                self.final_status = runner.PAID_FAILURE_RECURRENCE_GUARD_FINAL_STATUS

        stdout = io.StringIO()
        stderr = io.StringIO()
        with (
            tempfile.TemporaryDirectory() as temp_dir,
            mock.patch.object(runner, "Controller", FakeController),
            mock.patch.object(runner.sys, "stdout", stdout),
            mock.patch.object(runner.sys, "stderr", stderr),
        ):
            exit_code = runner.main(["run-single", "--run-id", "run-test", "--artifact-root", temp_dir])

        self.assertEqual(exit_code, 4)
        self.assertEqual(stdout.getvalue(), "")
        payload = json.loads(stderr.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["status"], runner.PAID_FAILURE_RECURRENCE_GUARD_FINAL_STATUS)
        self.assertEqual(payload["launchGuard"]["activeGuard"], "paid_failure_recurrence_guard")

    def test_bootstrap_worker_uses_configured_worker_user(self) -> None:
        args = controller_args()
        args.worker_user = "custom-worker"
        with tempfile.TemporaryDirectory() as temp_dir:
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            with mock.patch.object(controller, "ssh_cmd") as ssh_cmd:
                controller.bootstrap_worker()

        remote_command = ssh_cmd.call_args.args[1]
        command_tokens = shlex.split(remote_command)
        script = decode_remote_bash_lc(remote_command)
        self.assertIn("WORKER_USER=custom-worker", command_tokens)
        self.assertIn('sudo usermod -aG docker "$WORKER_USER" || true', script)
        self.assertIn('sudo chown -R "$WORKER_USER:$WORKER_USER"', script)
        self.assertNotIn("sudo usermod -aG docker screeps-batch", script)

    def test_bootstrap_worker_waits_for_apt_locks_before_package_commands(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=Path(temp_dir))
            with mock.patch.object(controller, "ssh_cmd") as ssh_cmd:
                controller.bootstrap_worker()

        script = decode_remote_bash_lc(ssh_cmd.call_args.args[1])
        for lock_path in (
            "/var/lib/dpkg/lock-frontend",
            "/var/lib/dpkg/lock",
            "/var/lib/apt/lists/lock",
            "/var/cache/apt/archives/lock",
        ):
            self.assertIn(lock_path, script)
        self.assertIn("APT_LOCK_WAIT_ATTEMPTS=60", script)
        self.assertIn("APT_LOCK_WAIT_SLEEP_SECONDS=5", script)
        self.assertIn(
            "APT_LOCK_WAIT_TOTAL_SECONDS=$((APT_LOCK_WAIT_ATTEMPTS * APT_LOCK_WAIT_SLEEP_SECONDS))",
            script,
        )
        self.assertIn("apt lock wait timeout before %s", script)
        self.assertIn("apt lock holder evidence path=%s pids=%s", script)
        self.assertIn("return 75", script)
        self.assertIn(
            'run_apt_get() {\n  local purpose="$1"\n  shift\n'
            '  local attempt deadline_epoch status stderr_file now\n'
            '  deadline_epoch="$(($(date +%s) + APT_LOCK_WAIT_TOTAL_SECONDS))"\n',
            script,
        )
        self.assertIn('wait_for_apt_locks "$purpose" "$deadline_epoch" || return $?', script)
        self.assertIn('if sudo apt-get "$@" 2>"$stderr_file"; then', script)
        self.assertIn('cat "$stderr_file" >&2', script)
        self.assertIn('if ! apt_get_lock_error "$stderr_file"; then', script)
        self.assertIn("apt lock retry timeout during %s", script)
        self.assertIn('run_apt_get "apt-get update" update -y', script)
        self.assertIn('run_apt_get "base package install" install -y', script)
        self.assertIn('run_apt_get "docker-compose-v2 install" install -y docker-compose-v2', script)
        self.assertIn('run_apt_get "docker-compose-plugin install" install -y docker-compose-plugin', script)
        self.assertIn('run_apt_get "docker-compose install" install -y docker-compose', script)
        self.assertIn("install_docker_compose_from_apt", script)
        self.assertNotIn("sudo apt-get update -y", script)
        self.assertNotIn("sudo apt-get install -y", script)
        self.assertNotIn(
            'run_apt_get "docker-compose-v2 install" install -y docker-compose-v2 || '
            'run_apt_get "docker-compose-plugin install" install -y docker-compose-plugin || '
            'run_apt_get "docker-compose install" install -y docker-compose || true',
            script,
        )

    def test_bootstrap_worker_retries_apt_lock_races_and_bounds_compose_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=Path(temp_dir))
            with mock.patch.object(controller, "ssh_cmd") as ssh_cmd:
                controller.bootstrap_worker()

        script = decode_remote_bash_lc(ssh_cmd.call_args.args[1])
        self.assertIn("apt_get_lock_error() {", script)
        self.assertIn("Could not get lock", script)
        self.assertIn("Unable to acquire.*lock", script)
        self.assertIn("Unable to lock.*directory", script)
        self.assertIn("is another process using it", script)
        self.assertIn("apt_get_package_resolution_error() {", script)
        self.assertIn("Unable to locate package", script)
        self.assertIn("has no installation candidate", script)
        self.assertIn("Couldn't find any package", script)
        self.assertIn("APT_GET_LAST_STDERR_FILE=", script)
        self.assertIn('if [ "$status" -eq 75 ]; then\n    return "$status"\n  fi', script)
        self.assertIn('if ! apt_get_package_resolution_error "$APT_GET_LAST_STDERR_FILE"; then', script)
        self.assertIn("docker-compose-v2 package unavailable; trying docker-compose-plugin", script)
        self.assertIn("docker-compose-plugin package unavailable; trying docker-compose", script)

    def test_preflight_step_details_are_flat(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_text(root / "maps" / "map-0b6758af.json", "{}\n")
            write_text(root / "prod" / "dist" / "main.js", "bundle\n")
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root / "artifacts")

            with mock.patch.object(runner, "REPO_ROOT", root):
                controller.ensure_map_present()
                controller.ensure_dist_present()

        self.assertEqual(controller.steps[0].detail["path"], str(root / "maps" / "map-0b6758af.json"))
        self.assertEqual(controller.steps[1].detail["path"], str(root / "prod" / "dist" / "main.js"))
        self.assertNotIn("detail", controller.steps[0].detail)
        self.assertNotIn("detail", controller.steps[1].detail)

    def test_multi_tier_map_preflight_validates_fixture_without_e1s1_map(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fixture_path = root / runner.MULTI_TIER_SIMULATION_MAP_SOURCE_REL
            fixture_path.parent.mkdir(parents=True)
            fixture_path.write_text(
                card_helper.MULTI_TIER_SIMULATION_MAP_SOURCE_FILE.read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            args = controller_args()
            args.scenario_id = runner.MULTI_TIER_SCENARIO_ID
            args.require_multi_tier_scenario = True
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=root / "artifacts")

            with mock.patch.object(runner, "REPO_ROOT", root):
                controller.ensure_map_present()

            self.assertEqual(controller.steps[0].detail["path"], str(fixture_path))
            self.assertEqual(controller.steps[0].detail["scenarioId"], runner.MULTI_TIER_SCENARIO_ID)
            self.assertEqual(controller.steps[0].detail["adjacentRoom"], "E2S1")
            self.assertEqual(controller.steps[0].detail["neutralExpansionRoomCount"], 2)
            self.assertEqual(controller.steps[0].detail["combatPressureRoom"], "E1S0")
            self.assertEqual(controller.steps[0].detail["hostileCreepCount"], 3)
            self.assertEqual(controller.steps[0].detail["hostileTowerCount"], 1)
            self.assertFalse((root / "maps" / "map-0b6758af.json").exists())

    def test_latest_scale_out_failure_ignores_failures_before_run_start(self) -> None:
        class FakeController(runner.Controller):
            def tccli(self, name: str, *params: str, check: bool = True, timeout: int = 90) -> dict[str, object]:
                return {
                    "ActivitySet": [
                        {
                            "ActivityId": "old",
                            "ActivityType": "SCALE_OUT",
                            "StatusCode": "FAILED",
                            "StartTime": "2026-05-17T00:00:00Z",
                        },
                        {
                            "ActivityId": "new",
                            "ActivityType": "SCALE_OUT",
                            "StatusCode": "FAILED",
                            "StartTime": "2026-05-17T00:01:00Z",
                        },
                    ]
                }

        with tempfile.TemporaryDirectory() as temp_dir:
            controller = FakeController(args=controller_args(), run_id="run-test", artifact_dir=Path(temp_dir) / "run-test")

            failure = controller.latest_scale_out_failure(
                after_epoch=runner.parse_tencent_activity_time("2026-05-17T00:00:30Z") or 0
            )

            self.assertIsNotNone(failure)
            self.assertEqual(failure.get("ActivityId"), "new")


if __name__ == "__main__":
    unittest.main()
