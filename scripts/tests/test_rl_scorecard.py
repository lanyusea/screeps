from __future__ import annotations

import io
import json
import sys
from pathlib import Path
from typing import Any


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import screeps_rl_scorecard as scorecard
import screeps_rl_training_runner as training_runner


JsonObject = dict[str, Any]


def write_json(path: Path, payload: JsonObject) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")


def runtime_line(payload: JsonObject) -> str:
    return f"#runtime-summary {json.dumps(payload, sort_keys=True)}\n"


def runtime_payload(
    *,
    tick: int,
    progress: int,
    harvested: int,
    stored: int,
    available: int,
    built: int,
    low_load: int,
    return_factor: float,
    loop_exceptions: int = 0,
    cpu_bucket: int = 9000,
    cpu_used: float = 8.0,
) -> JsonObject:
    return {
        "type": "runtime-summary",
        "tick": tick,
        "cpu": {"bucket": cpu_bucket, "used": cpu_used},
        "reliability": {"loopExceptionCount": loop_exceptions, "telemetrySilenceTicks": 0},
        "rooms": [
            {
                "roomName": "E26S49",
                "controller": {"my": True, "level": 3, "progress": progress, "ticksToDowngrade": 12000},
                "workerCount": 4,
                "spawnStatus": [{"name": "Spawn1", "status": "idle"}],
                "energyAvailable": available,
                "taskCounts": {"harvest": 1, "build": 1, "repair": 0, "upgrade": 2},
                "resources": {
                    "storedEnergy": stored,
                    "events": {"harvestedEnergy": harvested, "transferredEnergy": 25},
                    "productiveEnergy": {
                        "builtProgress": built,
                        "repairProgress": 10,
                        "upgradeProgress": 20,
                        "buildCarriedEnergy": 10,
                    },
                },
                "structures": {"spawn": 1, "tower": 1, "rampart": 2},
                "behavior": {"lowLoadReturnCount": low_load, "returnLoadFactor": return_factor},
                "combat": {"hostileCreepCount": 0, "events": {"creepDestroyedCount": 0, "objectDestroyedCount": 0}},
            }
        ],
    }


def write_bundle(root: Path, *, candidate: bool, safety_regression: bool = False) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    first = runtime_payload(
        tick=100,
        progress=1000,
        harvested=90 if not candidate else 110,
        stored=750 if not candidate else 850,
        available=200 if not candidate else 250,
        built=40 if not candidate else 60,
        low_load=2 if not candidate else 1,
        return_factor=0.55 if not candidate else 0.7,
        loop_exceptions=0,
        cpu_used=8.0 if not candidate else 7.5,
    )
    second = runtime_payload(
        tick=200,
        progress=1200 if not candidate else 1600,
        harvested=100 if not candidate else 140,
        stored=800 if not candidate else 950,
        available=250 if not candidate else 350,
        built=45 if not candidate else 80,
        low_load=2 if not candidate else 0,
        return_factor=0.6 if not candidate else 0.75,
        loop_exceptions=1 if safety_regression else 0,
        cpu_bucket=9000 if not safety_regression else 400,
        cpu_used=8.1 if not candidate else 7.4,
    )
    (root / "runtime.log").write_text(runtime_line(first) + runtime_line(second), encoding="utf-8")
    write_json(
        root / "training-ledger.json",
        {
            "type": "screeps-rl-training-report",
            "reportId": "training-candidate" if candidate else "training-baseline",
            "changedTopCount": 1,
            "rankingDiffCount": 1,
            "incumbentStrategyIds": ["incumbent.v1"],
            "ranking": [
                {"variantId": "candidate.v1", "reward": {"tuple": [0, 0, 2 if candidate else 1, 0]}},
                {"variantId": "incumbent.v1", "reward": {"tuple": [0, 0, 1, 0]}},
            ],
        },
    )
    write_json(
        root / "policy-advantage.json",
        {
            "type": "screeps-rl-policy-advantage-report",
            "reportId": "advantage-candidate" if candidate else "advantage-baseline",
            "advantageTerritory": 0,
            "advantageResources": 2 if candidate else 1,
            "advantageKills": 0,
        },
    )
    if candidate:
        write_json(
            root / "runtime-parameter-injection.json",
            {
                "type": "screeps-rl-runtime-parameter-injection",
                "status": "injected",
                "runtimeParameterInjection": True,
                "inlineCandidatesRuntimeInjected": True,
                "candidateParameterScope": "runtime_injected",
                "policyUpdateEligible": True,
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            },
        )
    write_json(
        root / "postdeploy-summary.json",
        {
            "type": "postdeploy-summary",
            "ok": True,
            "status": "pass",
            "room_summaries": [{"room": "shardX/E26S49", "owned_spawns": 1, "owned_creeps": 4}],
        },
    )
    gate_path = root / "gate.json"
    write_json(
        gate_path,
        {
            "type": "screeps-rl-dataset-evaluation-gate",
            "gateId": "candidate-gate" if candidate else "baseline-gate",
            "status": "pass",
            "ok": True,
            "artifactPaths": [
                "runtime.log",
                "training-ledger.json",
                "policy-advantage.json",
                "runtime-parameter-injection.json",
                "postdeploy-summary.json",
            ],
        },
    )
    return gate_path


def test_scorecard_passes_when_candidate_improves_without_regression(tmp_path: Path) -> None:
    baseline = write_bundle(tmp_path / "baseline", candidate=False)
    candidate = write_bundle(tmp_path / "candidate", candidate=True)

    report = scorecard.build_scorecard(
        candidate_path=candidate,
        baseline_path=baseline,
        repo_root=tmp_path,
        timestamp="2026-05-11T00:00:00Z",
        run_id="scorecard-pass",
    )

    assert report["overallGate"]["status"] == "PASS"
    assert report["scorecardContract"]["statusValues"] == [
        "PASS",
        "HOLD",
        "MIXED",
        "ROLLBACK_REQUIRED",
        "INCONCLUSIVE",
    ]
    assert report["overallGate"]["runtimeCandidateGate"]["status"] == "injected"
    assert report["dimensions"]["safety_reliability_floor"]["status"] in {"neutral", "improved"}
    assert report["dimensions"]["territory_expansion"]["status"] == "improved"
    assert report["dimensions"]["resources_economy"]["status"] == "improved"
    assert report["dimensions"]["construction_infrastructure"]["status"] == "improved"
    assert report["dimensions"]["creep_efficiency"]["status"] == "improved"
    assert report["dimensions"]["combat"]["status"] == "neutral"
    assert report["overallGate"]["monotonic"]["improvedNonSafetyDimension"] is True


def test_scorecard_fails_safety_regression_even_with_gameplay_gain(tmp_path: Path) -> None:
    baseline = write_bundle(tmp_path / "baseline", candidate=False)
    candidate = write_bundle(tmp_path / "candidate", candidate=True, safety_regression=True)

    report = scorecard.build_scorecard(
        candidate_path=candidate,
        baseline_path=baseline,
        repo_root=tmp_path,
        timestamp="2026-05-11T00:00:00Z",
        run_id="scorecard-fail",
    )

    assert report["overallGate"]["status"] == "ROLLBACK_REQUIRED"
    assert report["dimensions"]["safety_reliability_floor"]["status"] == "regressed"
    assert "safety_reliability_floor" in report["overallGate"]["safetyRegressions"]
    assert any("safety" in action.lower() for action in report["requiredActions"])


def test_scorecard_is_inconclusive_when_gameplay_evidence_is_absent(tmp_path: Path) -> None:
    baseline = tmp_path / "baseline-gate.json"
    candidate = tmp_path / "candidate-gate.json"
    write_json(
        baseline,
        {"type": "screeps-rl-dataset-evaluation-gate", "gateId": "baseline", "status": "pass", "ok": True},
    )
    write_json(
        candidate,
        {"type": "screeps-rl-dataset-evaluation-gate", "gateId": "candidate", "status": "pass", "ok": True},
    )

    report = scorecard.build_scorecard(
        candidate_path=candidate,
        baseline_path=baseline,
        repo_root=tmp_path,
        timestamp="2026-05-11T00:00:00Z",
        run_id="scorecard-inconclusive",
    )

    assert report["overallGate"]["status"] == "INCONCLUSIVE"
    assert report["dimensions"]["territory_expansion"]["status"] == "inconclusive"
    assert report["dimensions"]["resources_economy"]["status"] == "inconclusive"
    assert report["dimensions"]["combat"]["status"] == "neutral"


def test_runtime_injected_loop_b_scorecard_reports_mixed_contract_status(tmp_path: Path) -> None:
    baseline = tmp_path / "baseline"
    candidate = tmp_path / "candidate"
    baseline.mkdir()
    candidate.mkdir()
    loop_b_report = {
        "type": "screeps-rl-policy-online-advantage-report",
        "onlineUtilityStatus": "PROVEN",
        "candidatePolicyId": "candidate-runtime-injected",
        "baselinePolicyId": "incumbent-runtime-baseline",
        "trainingReportIds": ["training-runtime-injected"],
        "controllerSummary": {"finalStatus": "completed", "instanceId": "ins-runtime"},
        "metricsByCategory": {
            "reliability": {"candidateValue": 0.995, "baselineValue": 0.995, "delta": 0},
            "territory": {"candidateValue": 3, "baselineValue": 2, "delta": 1},
            "resources": {"candidateValue": 900, "baselineValue": 1000, "delta": -100},
            "kills": {"candidateValue": 2, "baselineValue": 0, "delta": 2},
        },
    }
    write_json(candidate / "policy-online-advantage.json", loop_b_report)
    write_json(baseline / "policy-online-advantage.json", loop_b_report)
    write_json(
        candidate / "runtime-parameter-injection.json",
        {
            "type": "screeps-rl-runtime-parameter-injection",
            "status": "injected",
            "runtimeParameterInjection": True,
            "inlineCandidatesRuntimeInjected": True,
            "candidateParameterScope": "runtime_injected",
            "policyUpdateEligible": True,
        },
    )

    report = scorecard.build_scorecard(
        candidate_path=candidate,
        baseline_path=baseline,
        repo_root=tmp_path,
        timestamp="2026-05-20T00:00:00Z",
        run_id="scorecard-runtime-mixed",
    )

    assert report["overallGate"]["status"] == "MIXED"
    assert report["overallGate"]["lexicographic"]["order"] == ["reliability", "territory", "resources", "kills"]
    assert report["dimensions"]["safety_reliability_floor"]["status"] == "neutral"
    assert report["dimensions"]["territory_expansion"]["status"] == "improved"
    assert report["dimensions"]["resources_economy"]["status"] == "regressed"
    assert report["dimensions"]["combat"]["status"] == "improved"
    assert report["candidate"]["runtimeParameterInjection"]["status"] == "injected"


def test_candidate_scorecard_readiness_uses_selected_candidate_runtime_evidence() -> None:
    report = {
        "reportId": "multi-candidate-selected-runtime-ready",
        "ranking": [
            {"variantId": "candidate.v1", "rank": 1},
            {"variantId": "baseline.v1", "rank": 2},
            {"variantId": "loser.v1", "rank": 3},
        ],
        "incumbentStrategyIds": ["baseline.v1"],
        "runtimeParameterInjection": {
            "status": "partial",
            "runtimeParameterInjection": False,
            "candidateParameterScope": "partial_runtime_injection",
            "injectedVariantCount": 1,
            "variants": [
                {"variantId": "candidate.v1", "runtimeParameterInjection": True},
                {"variantId": "loser.v1", "runtimeParameterInjection": False},
            ],
        },
        "variantResults": [
            {
                "variantId": "candidate.v1",
                "runtimeParameterInjection": {
                    "status": "injected",
                    "runtimeParameterInjection": True,
                    "candidateParameterScope": "runtime_injected",
                },
            },
            {"variantId": "baseline.v1"},
            {
                "variantId": "loser.v1",
                "runtimeParameterInjection": {
                    "status": "metadata_only",
                    "runtimeParameterInjection": False,
                    "candidateParameterScope": "metadata_only",
                },
            },
        ],
    }

    readiness = training_runner.build_candidate_scorecard_readiness(report)

    assert readiness["status"] == "ready"
    assert readiness["classification"] == "runtime_injected_candidate_scorecard_ready"
    assert readiness["runtimeParameterInjection"] is True
    assert readiness["injectedVariantCount"] == 1
    assert readiness["candidateParameterScope"] == "runtime_injected"
    assert readiness["reportRuntimeParameterInjection"] is False
    assert readiness["reportInjectedVariantCount"] == 1
    assert readiness["validationScaleComputeBlocked"] is False
    assert readiness["scorecardUsable"] is True
    assert "missingPrerequisite" not in readiness


def test_delta_only_safety_floor_metric_does_not_create_false_rollback(tmp_path: Path) -> None:
    baseline = tmp_path / "baseline"
    candidate = tmp_path / "candidate"
    baseline.mkdir()
    candidate.mkdir()
    loop_b_report = {
        "type": "screeps-rl-policy-online-advantage-report",
        "onlineUtilityStatus": "PROVEN",
        "candidatePolicyId": "candidate-runtime-injected",
        "baselinePolicyId": "incumbent-runtime-baseline",
        "trainingReportIds": ["training-runtime-delta-only"],
        "controllerSummary": {"finalStatus": "completed", "workerUser": "batch-worker"},
        "metricsByCategory": {
            "reliability": {"delta": 0.01},
            "territory": {"candidateValue": 3, "baselineValue": 2, "delta": 1},
            "resources": {"candidateValue": 1200, "baselineValue": 1000, "delta": 200},
            "kills": {"candidateValue": 0, "baselineValue": 0, "delta": 0},
        },
    }
    for root, role in ((baseline, "baseline"), (candidate, "candidate")):
        write_json(root / "policy-online-advantage.json", loop_b_report)
        write_json(
            root / "gate.json",
            {
                "type": "screeps-rl-dataset-evaluation-gate",
                "gateId": f"{role}-gate",
                "status": "pass",
                "ok": True,
            },
        )
    write_json(
        candidate / "runtime-parameter-injection.json",
        {
            "type": "screeps-rl-runtime-parameter-injection",
            "status": "injected",
            "runtimeParameterInjection": True,
            "inlineCandidatesRuntimeInjected": True,
            "candidateParameterScope": "runtime_injected",
            "policyUpdateEligible": True,
        },
    )

    report = scorecard.build_scorecard(
        candidate_path=candidate,
        baseline_path=baseline,
        repo_root=tmp_path,
        timestamp="2026-05-20T00:03:00Z",
        run_id="scorecard-runtime-delta-only-safety",
    )

    safety = report["dimensions"]["safety_reliability_floor"]
    reliability = next(metric for metric in safety["metrics"] if metric["metric"] == "reliability_score")
    assert report["overallGate"]["status"] == "PASS"
    assert report["overallGate"]["safetyRegressions"] == []
    assert safety["status"] == "neutral"
    assert reliability["candidate"] is None
    assert reliability["baseline"] is None
    assert "reliability_score" in safety["missingEvidence"]


def test_runtime_scorecard_missing_baseline_metric_is_inconclusive_not_pass(tmp_path: Path) -> None:
    baseline = tmp_path / "baseline"
    candidate = tmp_path / "candidate"
    baseline.mkdir()
    candidate.mkdir()
    write_json(
        candidate / "candidate-kpis.json",
        {
            "type": "screeps-rl-kpi-window",
            "metrics": {
                "reliability": {"score": 0.996},
                "territory": {"ownedRooms": 2},
                "resources": {"score": 1500},
                "kills": {"score": 1},
            },
        },
    )
    write_json(
        baseline / "baseline-kpis.json",
        {
            "type": "screeps-rl-kpi-window",
            "metrics": {
                "reliability": {"score": 0.996},
                "territory": {"ownedRooms": 2},
            },
        },
    )
    write_json(
        candidate / "runtime-parameter-injection.json",
        {
            "type": "screeps-rl-runtime-parameter-injection",
            "status": "injected",
            "runtimeParameterInjection": True,
            "inlineCandidatesRuntimeInjected": True,
            "candidateParameterScope": "runtime_injected",
            "policyUpdateEligible": True,
        },
    )

    report = scorecard.build_scorecard(
        candidate_path=candidate,
        baseline_path=baseline,
        repo_root=tmp_path,
        timestamp="2026-05-20T00:05:00Z",
        run_id="scorecard-runtime-missing-baseline",
    )

    assert report["overallGate"]["status"] == "INCONCLUSIVE"
    assert report["overallGate"]["status"] != "PASS"
    assert "resources_economy" in report["overallGate"]["inconclusiveDimensions"]
    assert "combat" in report["overallGate"]["inconclusiveDimensions"]


def test_missing_dimension_metrics_carry_stable_reason_codes(tmp_path: Path) -> None:
    baseline = tmp_path / "baseline"
    candidate = tmp_path / "candidate"
    baseline.mkdir()
    candidate.mkdir()
    write_json(
        candidate / "candidate-kpis.json",
        {
            "type": "screeps-rl-kpi-window",
            "metrics": {
                "resources": {"score": 1500},
            },
        },
    )
    write_json(
        baseline / "baseline-kpis.json",
        {
            "type": "screeps-rl-kpi-window",
            "metrics": {},
        },
    )

    report = scorecard.build_scorecard(
        candidate_path=candidate,
        baseline_path=baseline,
        repo_root=tmp_path,
        timestamp="2026-05-20T00:06:00Z",
        run_id="scorecard-missing-reason-codes",
    )

    resources = report["dimensions"]["resources_economy"]
    productive = next(metric for metric in resources["metrics"] if metric["metric"] == "productive_energy")
    assert productive["candidate"] == 1500
    assert productive["baseline"] is None
    assert productive["reasonCodes"] == ["missing_baseline_metric"]
    productive_detail = next(
        detail for detail in resources["missingEvidenceDetails"] if detail["metric"] == "productive_energy"
    )
    assert productive_detail["reasonCodes"] == ["missing_baseline_metric"]
    assert productive_detail["baselineMissing"] is True
    assert productive_detail["candidateMissing"] is False
    construction = report["dimensions"]["construction_infrastructure"]
    assert "missing_candidate_metric" in construction["reasonCodes"]
    assert "missing_baseline_metric" in construction["reasonCodes"]


def test_metadata_only_policy_update_holds_even_with_complete_metric_advantage(tmp_path: Path) -> None:
    baseline = tmp_path / "baseline"
    candidate = tmp_path / "candidate"
    baseline.mkdir()
    candidate.mkdir()
    write_json(
        baseline / "baseline-kpis.json",
        {
            "type": "screeps-rl-kpi-window",
            "metrics": {
                "reliability": {"score": 0.996},
                "territory": {"ownedRooms": 2},
                "resources": {"score": 1000},
                "kills": {"score": 0},
            },
        },
    )
    write_json(
        candidate / "candidate-kpis.json",
        {
            "type": "screeps-rl-kpi-window",
            "metrics": {
                "reliability": {"score": 0.996},
                "territory": {"ownedRooms": 3},
                "resources": {"score": 1200},
                "kills": {"score": 1},
            },
        },
    )
    write_json(
        candidate / "metadata-only-training.json",
        {
            "type": "screeps-rl-training-report",
            "policyGradient": {
                "runner_support": {
                    "runtime_parameter_injection": False,
                    "candidate_parameter_scope": "metadata_only",
                }
            },
        },
    )

    report = scorecard.build_scorecard(
        candidate_path=candidate,
        baseline_path=baseline,
        repo_root=tmp_path,
        timestamp="2026-05-20T00:10:00Z",
        run_id="scorecard-metadata-only-hold",
    )

    assert report["overallGate"]["status"] == "HOLD"
    assert report["overallGate"]["status"] != "PASS"
    assert report["overallGate"]["runtimeCandidateGate"]["runtimeParameterInjection"] is False
    assert report["overallGate"]["monotonic"]["improvedNonSafetyDimension"] is True


def test_lexicographic_result_regresses_on_first_blocking_regression() -> None:
    result = scorecard.build_lexicographic_objectives(
        {
            "safety_reliability_floor": {"status": scorecard.STATUS_NEUTRAL, "missingEvidence": [], "safety": True},
            "territory_expansion": {"status": scorecard.STATUS_REGRESSED, "missingEvidence": [], "safety": False},
            "resources_economy": {
                "status": scorecard.STATUS_INCONCLUSIVE,
                "missingEvidence": ["productive_energy"],
                "safety": False,
            },
            "combat": {"status": scorecard.STATUS_NEUTRAL, "missingEvidence": [], "safety": False},
        }
    )

    assert result["result"] == scorecard.STATUS_REGRESSED
    assert result["firstBlockingObjective"] == "territory"
    assert result["firstRegressionObjective"] == "territory"


def test_lexicographic_result_stays_inconclusive_when_first_blocking_is_missing() -> None:
    result = scorecard.build_lexicographic_objectives(
        {
            "safety_reliability_floor": {"status": scorecard.STATUS_NEUTRAL, "missingEvidence": [], "safety": True},
            "territory_expansion": {
                "status": scorecard.STATUS_INCONCLUSIVE,
                "missingEvidence": ["owned_room_count"],
                "safety": False,
            },
            "resources_economy": {"status": scorecard.STATUS_REGRESSED, "missingEvidence": [], "safety": False},
            "combat": {"status": scorecard.STATUS_NEUTRAL, "missingEvidence": [], "safety": False},
        }
    )

    assert result["result"] == scorecard.STATUS_INCONCLUSIVE
    assert result["firstBlockingObjective"] == "territory"
    assert result["firstRegressionObjective"] == "resources"


def test_value_has_reference_parses_numeric_strings() -> None:
    assert not scorecard.value_has_reference("0")
    assert not scorecard.value_has_reference("0.0")
    assert not scorecard.value_has_reference(["0"])
    assert not scorecard.value_has_reference({"ids": ["0", {"fallback": "0.0"}]})
    assert scorecard.value_has_reference("1")
    assert scorecard.value_has_reference(["0", "2.5"])
    assert scorecard.value_has_reference("training-report-a")


def test_scorecard_ignores_preflight_only_policy_advantage_as_compute(tmp_path: Path) -> None:
    for case, training_report_ids in (
        ("empty-list", []),
        ("scalar-zero", 0),
        ("string-zero", "0"),
        ("string-float-zero", "0.0"),
        ("list-string-zero", ["0"]),
        ("nested-string-zero", {"ids": ["0", {"fallback": "0.0"}]}),
    ):
        baseline = tmp_path / case / "baseline"
        candidate = tmp_path / case / "candidate"
        baseline.mkdir(parents=True)
        candidate.mkdir(parents=True)
        for root, resources in ((baseline, 1), (candidate, 10)):
            write_json(
                root / "policy-advantage.json",
                {
                    "type": "screeps-rl-policy-advantage-report",
                    "reportId": f"preflight-{root.name}",
                    "advantageResources": resources,
                    "trainingReportIds": training_report_ids,
                    "environmentExecution": {"completed": 0},
                    "controllerSummary": {
                        "finalStatus": "preflight_ok",
                        "instanceId": None,
                        "environmentsRun": 0,
                    },
                },
            )

        report = scorecard.build_scorecard(
            candidate_path=candidate,
            baseline_path=baseline,
            repo_root=tmp_path,
            timestamp="2026-05-19T00:00:00Z",
            run_id=f"scorecard-preflight-only-{case}",
        )

        resources = report["dimensions"]["resources_economy"]
        self_metric = next(metric for metric in resources["metrics"] if metric["metric"] == "productive_energy")
        assert resources["status"] == "inconclusive"
        assert self_metric["candidate"] is None
        assert self_metric["baseline"] is None
        assert "productive_energy" in resources["missingEvidence"]


def test_scorecard_accepts_nonzero_string_training_report_ids_as_compute(tmp_path: Path) -> None:
    baseline = tmp_path / "baseline"
    candidate = tmp_path / "candidate"
    baseline.mkdir()
    candidate.mkdir()
    for root, resources in ((baseline, 1), (candidate, 10)):
        write_json(
            root / "policy-advantage.json",
            {
                "type": "screeps-rl-policy-advantage-report",
                "reportId": f"nonzero-training-id-{root.name}",
                "advantageResources": resources,
                "trainingReportIds": ["0", "2"],
                "environmentExecution": {"completed": 0},
                "controllerSummary": {
                    "finalStatus": "preflight_ok",
                    "instanceId": None,
                    "environmentsRun": 0,
                },
            },
        )

    report = scorecard.build_scorecard(
        candidate_path=candidate,
        baseline_path=baseline,
        repo_root=tmp_path,
        timestamp="2026-05-19T00:00:00Z",
        run_id="scorecard-nonzero-string-training-id",
    )

    resources = report["dimensions"]["resources_economy"]
    self_metric = next(metric for metric in resources["metrics"] if metric["metric"] == "productive_energy")
    assert resources["status"] == "improved"
    assert self_metric["candidate"] == 10
    assert self_metric["baseline"] == 1
    assert "productive_energy" not in resources["missingEvidence"]


def test_scorecard_preflight_marker_requires_controller_summary_shape() -> None:
    unrelated_status = {
        "type": "screeps-rl-training-report",
        "validation": {
            "status": {
                "finalStatus": "preflight_ok",
                "source": "unrelated schema status",
            }
        },
    }
    controller_summary = {
        "type": "screeps-rl-training-report",
        "controllerSummary": {
            "finalStatus": "preflight_ok",
            "instanceId": None,
            "environmentsRun": 0,
        },
    }
    environment_execution_summary = {
        "type": "screeps-rl-training-report",
        "controllerSummary": {
            "finalStatus": "preflight_ok",
            "environmentExecution": {"completed": 0},
        },
    }

    assert not scorecard.preflight_only_compute_payload(unrelated_status)
    assert scorecard.preflight_only_compute_payload(controller_summary)
    assert scorecard.preflight_only_compute_payload(environment_execution_summary)


def test_scorecard_ignores_blank_executor_identity_without_compute(tmp_path: Path) -> None:
    baseline = tmp_path / "baseline"
    candidate = tmp_path / "candidate"
    baseline.mkdir()
    candidate.mkdir()
    for root, resources in ((baseline, 1), (candidate, 10)):
        write_json(
            root / "policy-advantage.json",
            {
                "type": "screeps-rl-policy-advantage-report",
                "reportId": f"blank-executor-{root.name}",
                "advantageResources": resources,
                "controllerSummary": {
                    "finalStatus": "running",
                    "instanceId": " ",
                    "workerUser": "\t",
                },
            },
        )

    report = scorecard.build_scorecard(
        candidate_path=candidate,
        baseline_path=baseline,
        repo_root=tmp_path,
        timestamp="2026-05-19T00:00:00Z",
        run_id="scorecard-blank-executor",
    )

    resources = report["dimensions"]["resources_economy"]
    self_metric = next(metric for metric in resources["metrics"] if metric["metric"] == "productive_energy")
    assert resources["status"] == "inconclusive"
    assert self_metric["candidate"] is None
    assert self_metric["baseline"] is None
    assert "productive_energy" in resources["missingEvidence"]


def test_scorecard_ignores_policy_advantage_without_compute_evidence(tmp_path: Path) -> None:
    baseline = tmp_path / "baseline"
    candidate = tmp_path / "candidate"
    baseline.mkdir()
    candidate.mkdir()
    for root, resources in ((baseline, 1), (candidate, 10)):
        write_json(
            root / "policy-advantage.json",
            {
                "type": "screeps-rl-policy-advantage-report",
                "reportId": f"no-compute-{root.name}",
                "advantageResources": resources,
            },
        )

    report = scorecard.build_scorecard(
        candidate_path=candidate,
        baseline_path=baseline,
        repo_root=tmp_path,
        timestamp="2026-05-19T00:00:00Z",
        run_id="scorecard-no-compute-policy-advantage",
    )

    resources = report["dimensions"]["resources_economy"]
    self_metric = next(metric for metric in resources["metrics"] if metric["metric"] == "productive_energy")
    assert resources["status"] == "inconclusive"
    assert self_metric["candidate"] is None
    assert self_metric["baseline"] is None
    assert "productive_energy" in resources["missingEvidence"]


def test_scorecard_accepts_worker_user_controller_summary_compute_evidence(tmp_path: Path) -> None:
    baseline = tmp_path / "baseline"
    candidate = tmp_path / "candidate"
    baseline.mkdir()
    candidate.mkdir()
    for root, resources in ((baseline, 1), (candidate, 10)):
        write_json(
            root / "policy-advantage.json",
            {
                "type": "screeps-rl-policy-advantage-report",
                "reportId": f"worker-compute-{root.name}",
                "advantageResources": resources,
                "controllerSummary": {
                    "finalStatus": "completed",
                    "workerUser": "tencent-worker",
                    "environmentsRun": 0,
                },
            },
        )

    report = scorecard.build_scorecard(
        candidate_path=candidate,
        baseline_path=baseline,
        repo_root=tmp_path,
        timestamp="2026-05-19T00:00:00Z",
        run_id="scorecard-worker-user-compute",
    )

    resources = report["dimensions"]["resources_economy"]
    self_metric = next(metric for metric in resources["metrics"] if metric["metric"] == "productive_energy")
    assert resources["status"] == "improved"
    assert self_metric["candidate"] == 10
    assert self_metric["baseline"] == 1
    assert "productive_energy" not in resources["missingEvidence"]


def test_cli_writes_scorecard_json(tmp_path: Path) -> None:
    baseline = write_bundle(tmp_path / "baseline", candidate=False)
    candidate = write_bundle(tmp_path / "candidate", candidate=True)
    output = tmp_path / "scorecard.json"
    stdout = io.StringIO()

    exit_code = scorecard.main(
        [
            "--baseline",
            str(baseline),
            "--candidate",
            str(candidate),
            "--output",
            str(output),
            "--repo-root",
            str(tmp_path),
            "--timestamp",
            "2026-05-11T00:00:00Z",
            "--run-id",
            "scorecard-cli",
        ],
        stdout=stdout,
    )

    assert exit_code == 0
    saved = json.loads(output.read_text(encoding="utf-8"))
    summary = json.loads(stdout.getvalue())
    assert saved["runId"] == "scorecard-cli"
    assert saved["overallGate"]["status"] == "PASS"
    assert summary["overallGate"]["status"] == "PASS"
