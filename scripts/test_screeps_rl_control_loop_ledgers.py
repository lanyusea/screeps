#!/usr/bin/env python3
from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))

import screeps_rl_control_loop_ledgers as ledgers


JsonObject = dict[str, Any]


class BrokenWriter(io.StringIO):
    def write(self, _text: str) -> int:
        raise BrokenPipeError("simulated closed stdout")


class FlushBrokenWriter:
    def __init__(self) -> None:
        self.flush_attempts = 0
        self.write_attempts = 0

    def write(self, text: str) -> int:
        self.write_attempts += 1
        return len(text)

    def flush(self) -> None:
        self.flush_attempts += 1
        raise BrokenPipeError("simulated buffered closed stdout")

    def fileno(self) -> int:
        raise OSError("test stream has no file descriptor")


def write_json(path: Path, payload: JsonObject) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")


def read_json(path: Path) -> JsonObject:
    return json.loads(path.read_text(encoding="utf-8"))


def write_fixture_artifacts(root: Path) -> Path:
    artifact_root = root / "runtime-artifacts"
    write_json(
        artifact_root / "rl-dataset-gates" / "e1-lite" / "gate_report.json",
        {
            "type": "screeps-rl-dataset-evaluation-gate",
            "ok": True,
            "gateId": "e1-lite",
            "createdAt": "2026-06-04T19:45:47Z",
            "dataset": {"runId": "rl-e1-lite", "sampleCount": 20},
            "datasetGate": {"status": "pass", "sampleCount": 20},
            "quality_checks": {"status": "pass", "samples_accepted": 20, "samples_rejected": 0},
            "blockingReasons": [],
        },
    )
    write_json(
        artifact_root / "rl-control-loop" / "20260604T194547Z-training-ledger.json",
        {
            "type": "screeps-rl-training-execution-ledger",
            "createdAt": "2026-06-04T19:45:47Z",
            "status": "RUN_VALIDATED",
            "trainingDidRun": True,
            "e1Gate": {"gateId": "e1-lite", "ok": True, "datasetRunId": "rl-e1-lite", "sampleCount": 20},
            "environmentExecution": {"started": 2, "completed": 2, "failed": 0, "successRate": 1.0},
            "iterationExecution": {
                "simulatorTicksRequested": 200,
                "simulatorTicksRun": 200,
                "episodesRun": 2,
                "candidateEvaluationIterations": 1,
                "policyUpdateIterations": 1,
            },
            "trainingArtifacts": {
                "trainingReportIds": ["training-report-a"],
                "candidatePolicyIds": ["candidate-a"],
            },
            "metricsFields": {
                "envCompleted": 2,
                "ticksRun": 200,
                "episodes": 2,
                "policyUpdateIterations": 1,
                "trainingReportIds": ["training-report-a"],
                "candidatePolicyId": "candidate-a",
            },
        },
    )
    write_json(
        artifact_root / "rl-control-loop" / "20260604T194548Z-policy-advantage.json",
        {
            "type": "screeps-rl-policy-online-advantage-report",
            "createdAt": "2026-06-04T19:45:48Z",
            "candidatePolicyId": "candidate-a",
            "baselinePolicyId": "incumbent",
            "mode": "offline",
            "onlineUtilityStatus": "UNPROVEN",
            "metrics": {
                "territory": {"advantage": "tie", "candidateValue": 1, "baselineValue": 1, "delta": 0},
                "resources": {"advantage": "unknown", "candidateValue": None, "baselineValue": None, "delta": None},
            },
            "regressions": [],
            "nextExperimentCardDelta": "collect online KPI window",
        },
    )
    return artifact_root


LOCAL2W_REPORT_ID = (
    "rl-exp-rl-shadow-eval-20260603T045100Z-faa6f035b039-"
    "20260603T045230000000Z3f2cbc-local2w-20260603T0832Z-233f6cd29c2c"
)


def write_root_local2w_training_report_artifacts(
    root: Path,
    *,
    include_positive_policy: bool = False,
    trusted_gradient_update: bool = False,
) -> tuple[Path, str]:
    artifact_root = root / "runtime-artifacts"
    write_json(
        artifact_root / "rl-dataset-gates" / "e1-lite" / "gate_report.json",
        {
            "type": "screeps-rl-dataset-evaluation-gate",
            "ok": True,
            "gateId": "e1-lite",
            "createdAt": "2026-06-04T19:45:47Z",
            "dataset": {"runId": "rl-e1-lite", "sampleCount": 80},
            "datasetGate": {"status": "pass", "sampleCount": 80},
            "quality_checks": {"status": "pass", "samples_accepted": 80, "samples_rejected": 0},
            "blockingReasons": [],
        },
    )
    simulator_run_ids = [f"{LOCAL2W_REPORT_ID}-r{index:02d}" for index in range(1, 21)]
    write_json(
        artifact_root / "rl-training" / "issue-1588-local2w-20260603T0832Z.json",
        {
            "type": "screeps-rl-training-report",
            "schemaVersion": 1,
            "generatedAt": "2026-06-03T15:08:50Z",
            "status": "shadow",
            "reportId": "issue-1588-local2w-20260603T0832Z",
            "artifactCount": 79,
            "batchScale": {"environmentRows": 79, "simulatorTicks": 158000},
            "source": {"simulatorRunCount": 20, "simulatorRunIds": ["issue-1588-local2w-20260603T0832Z-r01"]},
            "policyUpdateIterations": 1,
            "trustedGradientUpdate": True,
            "gradientStable": True,
        },
    )
    write_json(
        artifact_root / "rl-training" / f"{LOCAL2W_REPORT_ID}.json",
        {
            "type": "screeps-rl-training-report",
            "schemaVersion": 1,
            "generatedAt": "2026-06-04T21:53:40Z",
            "status": "shadow",
            "reportId": LOCAL2W_REPORT_ID,
            "artifactCount": 80,
            "batchScale": {
                "environmentRows": 80,
                "simulatorTicks": 160000,
                "wallClockSeconds": 23235.616,
            },
            "simulation": {"repetitions": 20, "ticks": 2000, "workers": 2},
            "source": {
                "experimentCardPath": "runtime-artifacts/rl-experiment-cards/experiment_card-local2w-20260603T0832Z.json",
                "simulatorRunCount": 20,
                "simulatorRunIds": simulator_run_ids,
            },
            "variantResults": [
                {
                    "variantId": "construction-priority.pg.incumbent-seed.v1",
                    "candidatePolicyId": "construction-priority.pg.incumbent-seed.v1",
                    "ok": True,
                    "sampleCount": 20,
                    "runtimeParameterInjection": {"runtimeParameterConsumption": True},
                },
                {
                    "variantId": "construction-priority.pg.territory-seed.v1",
                    "candidatePolicyId": "construction-priority.pg.territory-seed.v1",
                    "ok": True,
                    "sampleCount": 20,
                    "runtimeParameterInjection": {"runtimeParameterConsumption": True},
                },
                {
                    "variantId": "construction-priority.pg.resource-seed.v1",
                    "candidatePolicyId": "construction-priority.pg.resource-seed.v1",
                    "ok": True,
                    "sampleCount": 20,
                    "runtimeParameterInjection": {"runtimeParameterConsumption": True},
                },
                {
                    "variantId": "construction-priority.pg.risk-aware-seed.v1",
                    "candidatePolicyId": "construction-priority.pg.risk-aware-seed.v1",
                    "ok": True,
                    "sampleCount": 20,
                    "runtimeParameterInjection": {"runtimeParameterConsumption": True},
                },
            ],
            "policyUpdateIterations": 1,
            "trueGradient": True,
            "policyUpdateCandidatePolicyId": f"{LOCAL2W_REPORT_ID}.next-policy",
            "policyUpdateArtifactPath": f"runtime-artifacts/rl-training/policy-candidates/{LOCAL2W_REPORT_ID}-next-policy.json",
            "policyUpdate": {
                "iterations": 1,
                "nextCandidatePolicy": {"candidatePolicyId": f"{LOCAL2W_REPORT_ID}.next-policy"},
            },
            "runtimeParameterInjection": {
                "runtimeParameterConsumption": True,
                "consumedVariantCount": 4,
                "runtimeParameterInjection": True,
            },
            "policyUpdatePromotionGate": {
                "status": "ready" if trusted_gradient_update else "blocked_gradient_stability_untrusted",
                "runtimeParameterConsumption": True,
                "trustedGradientUpdate": trusted_gradient_update,
                "gradientStable": trusted_gradient_update,
                "reason": None if trusted_gradient_update else "true-gradient estimate conflicts with momentum direction",
            },
            "trustedGradientUpdate": trusted_gradient_update,
            "gradientStable": trusted_gradient_update,
            "scorecardId": f"rl-scorecard-{LOCAL2W_REPORT_ID}-187e0c0e1786",
            "scorecardArtifactPath": (
                "runtime-artifacts/rl-training/candidate-scorecards/"
                f"{LOCAL2W_REPORT_ID}/rl-scorecard-{LOCAL2W_REPORT_ID}-187e0c0e1786.json"
            ),
            "candidateScorecard": {
                "status": "ready" if trusted_gradient_update else "materialized",
                "classification": (
                    "runtime_injected_candidate_scorecard_ready"
                    if trusted_gradient_update
                    else "gradient_stability_untrusted_scorecard_materialized"
                ),
                "scorecardId": f"rl-scorecard-{LOCAL2W_REPORT_ID}-187e0c0e1786",
                "scorecardArtifactPath": (
                    "runtime-artifacts/rl-training/candidate-scorecards/"
                    f"{LOCAL2W_REPORT_ID}/rl-scorecard-{LOCAL2W_REPORT_ID}-187e0c0e1786.json"
                ),
                "candidateStrategyId": "construction-priority.pg.risk-aware-seed.v1",
                "baselineStrategyId": "construction-priority.pg.incumbent-seed.v1",
                "validationScaleComputeBlocked": not trusted_gradient_update,
                "scorecardUsable": True,
            },
        },
    )
    if include_positive_policy:
        write_json(
            artifact_root / "rl-control-loop" / "20260604T220000Z-policy-advantage.json",
            {
                "type": ledgers.POLICY_ADVANTAGE_TYPE,
                "createdAt": "2026-06-04T22:00:00Z",
                "candidatePolicyId": f"{LOCAL2W_REPORT_ID}.next-policy",
                "baselinePolicyId": "incumbent",
                "onlineUtilityStatus": "PROVEN",
                "metrics": {
                    "territory": {"advantage": "advantage", "candidateValue": 2, "baselineValue": 1, "delta": 1},
                    "resources": {"advantage": "tie", "candidateValue": 1, "baselineValue": 1, "delta": 0},
                },
                "regressions": [],
                "evidenceWindows": {"trainingReportIds": [LOCAL2W_REPORT_ID]},
            },
        )
    return artifact_root, LOCAL2W_REPORT_ID


def local2w_next_policy_id() -> str:
    return f"{LOCAL2W_REPORT_ID}.next-policy"


def local2w_scorecard_id() -> str:
    return f"rl-scorecard-{LOCAL2W_REPORT_ID}-187e0c0e1786"


def write_legacy_scorecard_reward_decision(
    root: Path,
    artifact_root: Path,
    *,
    scorecard_id: str,
    candidate_policy_id: str,
) -> tuple[str, str]:
    legacy_scorecard_id = (
        f"{scorecard_id} (selected best), also rl-scorecard-...-7f7682d0397f, "
        "rl-scorecard-...-ed14bbc41bea (3 total)"
    )
    reward_decision_id = ledgers.reward_decision_id_for_scorecard(legacy_scorecard_id, candidate_policy_id)
    path = artifact_root / "rl-control-loop" / "reward-decisions" / f"{reward_decision_id}.json"
    write_json(
        path,
        {
            "type": ledgers.REWARD_DECISION_RECORD_TYPE,
            "schemaVersion": ledgers.SCHEMA_VERSION,
            "rewardDecisionId": reward_decision_id,
            "scorecardId": legacy_scorecard_id,
            "candidatePolicyId": candidate_policy_id,
            "createdAt": "2026-06-05T00:00:00Z",
            "updatedAt": "2026-06-05T00:00:00Z",
        },
    )
    return reward_decision_id, path.relative_to(root).as_posix()


class ScreepsRlControlLoopLedgersTest(unittest.TestCase):
    def test_load_json_rejects_artifact_over_byte_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            path = root / "oversized.json"
            original_limit = ledgers.MAX_JSON_ARTIFACT_BYTES
            try:
                ledgers.MAX_JSON_ARTIFACT_BYTES = 32
                path.write_text(json.dumps({"payload": "x" * 64}), encoding="utf-8")

                payload = ledgers.load_json(path)
            finally:
                ledgers.MAX_JSON_ARTIFACT_BYTES = original_limit

        self.assertIsNone(payload)

    def test_load_json_rejects_artifact_over_depth_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            path = root / "deep.json"
            original_limit = ledgers.MAX_JSON_ARTIFACT_DEPTH
            try:
                ledgers.MAX_JSON_ARTIFACT_DEPTH = 2
                write_json(path, {"a": {"b": {"c": "too deep"}}})

                payload = ledgers.load_json(path)
            finally:
                ledgers.MAX_JSON_ARTIFACT_DEPTH = original_limit

        self.assertIsNone(payload)

    def test_json_safe_marks_over_depth_and_circular_branches(self) -> None:
        circular: list[Any] = []
        circular.append(circular)
        original_limit = ledgers.MAX_JSON_ARTIFACT_DEPTH
        try:
            ledgers.MAX_JSON_ARTIFACT_DEPTH = 2

            payload = ledgers.json_safe(
                {
                    "path": Path("runtime-artifacts/rl-control-loop/example.json"),
                    "deep": {"a": {"b": {"c": "too deep"}}},
                    "circular": circular,
                }
            )
        finally:
            ledgers.MAX_JSON_ARTIFACT_DEPTH = original_limit

        self.assertEqual(payload["path"], "runtime-artifacts/rl-control-loop/example.json")
        self.assertEqual(payload["deep"]["a"]["b"], ledgers.JSON_DEPTH_LIMIT_MARKER)
        self.assertEqual(payload["circular"], [ledgers.JSON_CIRCULAR_REFERENCE_MARKER])

    def test_reward_decision_text_scrub_ignores_over_depth_branch_without_recursion_error(self) -> None:
        nested: Any = "rewardDecisionId=null"
        for _ in range(sys.getrecursionlimit() + 20):
            nested = [nested]

        payload = ledgers.reward_decision_consistent_text(
            nested,
            reward_decision_id="reward-decision-test",
            reward_decision_artifact_path="runtime-artifacts/rl-control-loop/reward-decisions/reward-decision-test.json",
            field="rolloutGate",
        )

        self.assertIs(payload, nested)

    def test_reward_decision_text_scrub_handles_circular_branch(self) -> None:
        circular: JsonObject = {"reason": "rewardDecisionId=null"}
        circular["self"] = circular

        payload = ledgers.reward_decision_consistent_text(
            circular,
            reward_decision_id="reward-decision-test",
            reward_decision_artifact_path=None,
            field="rolloutGate",
        )

        self.assertIs(payload["self"], circular)
        self.assertTrue(payload["reason"].startswith("BLOCKED. rewardDecisionId reward-decision-test is available"))

    def test_training_ledger_writes_artifact_when_stdout_is_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = write_fixture_artifacts(root)
            output = root / "out" / "training-ledger.json"
            stderr = io.StringIO()

            exit_code = ledgers.main(
                [
                    "training-ledger",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T00:00:00Z",
                    "--max-files-per-root",
                    "4",
                ],
                stdout=BrokenWriter(),
                stderr=stderr,
            )
            payload = read_json(output)

        self.assertEqual(exit_code, 0)
        self.assertEqual(stderr.getvalue(), "")
        self.assertEqual(payload["type"], ledgers.TRAINING_LEDGER_TYPE)
        self.assertEqual(payload["status"], "RUN_VALIDATED")
        self.assertTrue(payload["trainingDidRun"])
        self.assertEqual(payload["metricsFields"]["envCompleted"], 2)
        self.assertEqual(payload["githubComment"], "skipped_no_atomic_issue")

    def test_training_ledger_treats_flush_broken_stdout_as_delivery_only(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = write_fixture_artifacts(root)
            output = root / "out" / "training-ledger.json"
            stdout = FlushBrokenWriter()
            stderr = io.StringIO()

            exit_code = ledgers.main(
                [
                    "training-ledger",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T00:00:00Z",
                    "--max-files-per-root",
                    "4",
                ],
                stdout=stdout,
                stderr=stderr,
            )
            payload = read_json(output)

        self.assertEqual(exit_code, 0)
        self.assertEqual(stderr.getvalue(), "")
        self.assertEqual(stdout.write_attempts, 1)
        self.assertEqual(stdout.flush_attempts, 1)
        self.assertEqual(payload["type"], ledgers.TRAINING_LEDGER_TYPE)
        self.assertEqual(payload["status"], "RUN_VALIDATED")

    def test_training_ledger_does_not_reuse_generated_ledger_as_compute_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = root / "runtime-artifacts"
            write_json(
                artifact_root / "rl-dataset-gates" / "e1-lite" / "gate_report.json",
                {
                    "type": "screeps-rl-dataset-evaluation-gate",
                    "createdAt": "2026-06-04T19:45:46Z",
                    "ok": True,
                    "gateId": "e1-lite",
                    "dataset": {"runId": "rl-e1-lite", "sampleCount": 20},
                    "datasetGate": {"status": "pass", "sampleCount": 20},
                    "quality_checks": {"status": "pass", "samples_accepted": 20, "samples_rejected": 0},
                    "blockingReasons": [],
                },
            )
            write_json(
                artifact_root / "rl-control-loop" / "20260604T194547Z-training-ledger.json",
                {
                    "type": ledgers.TRAINING_LEDGER_TYPE,
                    "createdAt": "2026-06-04T19:45:47Z",
                    "status": "RUN_VALIDATED",
                    "trainingDidRun": True,
                    "environmentExecution": {"completed": 2, "failed": 0},
                    "iterationExecution": {"simulatorTicksRun": 200, "episodesRun": 2, "policyUpdateIterations": 1},
                    "boundedProducer": {"maxFilesPerRoot": 4},
                },
            )
            output = root / "out" / "training-ledger.json"

            exit_code = ledgers.main(
                [
                    "training-ledger",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T00:00:00Z",
                    "--max-files-per-root",
                    "4",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            payload = read_json(output)

        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["status"], "NOT_RUN")
        self.assertFalse(payload["trainingDidRun"])
        self.assertEqual(payload["environmentExecution"]["completed"], 0)
        self.assertEqual(payload["trainingArtifacts"]["latestTrainingLedger"], None)
        self.assertIn("TRAINING_LEDGER_MISSING", {item["code"] for item in payload["anomalies"]})

    def test_training_ledger_ingests_root_level_local2w_training_report(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root, report_id = write_root_local2w_training_report_artifacts(root)
            output = root / "out" / "training-ledger.json"

            exit_code = ledgers.main(
                [
                    "training-ledger",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T00:00:00Z",
                    "--max-files-per-root",
                    "4",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            payload = read_json(output)

        anomaly_codes = {item["code"] for item in payload["anomalies"]}
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["status"], "RUN_VALIDATED")
        self.assertTrue(payload["trainingDidRun"])
        self.assertEqual(payload["environmentExecution"]["completed"], 80)
        self.assertEqual(payload["iterationExecution"]["simulatorTicksRun"], 160000)
        self.assertEqual(payload["iterationExecution"]["policyUpdateIterations"], 1)
        self.assertEqual(payload["trainingArtifacts"]["trainingReportIds"], [report_id])
        self.assertEqual(payload["metricsFields"]["envCompleted"], 80)
        self.assertEqual(payload["metricsFields"]["policyUpdateIterations"], 1)
        self.assertEqual(payload["metricsFields"]["trainingReportIds"], [report_id])
        self.assertTrue(payload["trainingArtifacts"]["latestTrainingLedger"].endswith(f"{report_id}.json"))
        self.assertNotIn("TRAINING_COMPUTE_EVIDENCE_MISSING", anomaly_codes)
        self.assertNotIn("TRAINING_LEDGER_MISSING", anomaly_codes)
        self.assertNotIn("activeRunner PID 1012127", payload["nextTrainingCapabilityAction"])

    def test_training_ledger_propagates_existing_reward_decision_and_clears_null_anomaly(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root, report_id = write_root_local2w_training_report_artifacts(root, trusted_gradient_update=True)
            candidate_policy_id = local2w_next_policy_id()
            scorecard_id = local2w_scorecard_id()
            reward_decision_id, reward_decision_path = write_legacy_scorecard_reward_decision(
                root,
                artifact_root,
                scorecard_id=scorecard_id,
                candidate_policy_id=candidate_policy_id,
            )
            write_json(
                artifact_root / "rl-control-loop" / "20260605T000001Z-policy-advantage.json",
                {
                    "type": ledgers.POLICY_ADVANTAGE_TYPE,
                    "createdAt": "2026-06-05T00:00:01Z",
                    "candidatePolicyId": candidate_policy_id,
                    "baselinePolicyId": "incumbent",
                    "onlineUtilityStatus": "UNPROVEN",
                    "rewardDecisionId": None,
                    "rewardDecisionArtifactPath": None,
                    "scorecardId": scorecard_id,
                    "metrics": {},
                },
            )
            write_json(
                artifact_root / "rl-control-loop" / "20260605T000002Z-training-ledger.json",
                {
                    "type": ledgers.TRAINING_LEDGER_TYPE,
                    "createdAt": "2026-06-05T00:00:02Z",
                    "status": "RUN_VALIDATED",
                    "trainingDidRun": True,
                    "environmentExecution": {"started": 80, "completed": 80, "failed": 0, "successRate": 1.0},
                    "iterationExecution": {
                        "simulatorTicksRequested": 160000,
                        "simulatorTicksRun": 160000,
                        "episodesRun": 80,
                        "candidateEvaluationIterations": 1,
                        "policyUpdateIterations": 1,
                    },
                    "trainingArtifacts": {
                        "trainingReportIds": [report_id],
                        "candidatePolicyIds": [candidate_policy_id],
                        "rewardDecisionId": None,
                        "rewardDecisionArtifactPath": None,
                    },
                    "metricsFields": {
                        "envCompleted": 80,
                        "ticksRun": 160000,
                        "episodes": 80,
                        "policyUpdateIterations": 1,
                        "trainingReportIds": [report_id],
                        "candidatePolicyId": candidate_policy_id,
                        "rewardDecisionId": None,
                    },
                    "anomalies": [
                        {"severity": "P1", "code": "REWARD_DECISION_ID_NULL"},
                        {"severity": "P2", "code": "E1_GATE_STALE"},
                    ],
                },
            )
            output = root / "out" / "training-ledger.json"

            exit_code = ledgers.main(
                [
                    "training-ledger",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T00:00:03Z",
                    "--max-files-per-root",
                    "4",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            payload = read_json(output)

        anomaly_codes = {item["code"] for item in payload["anomalies"]}
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["rewardDecisionId"], reward_decision_id)
        self.assertEqual(payload["rewardDecisionArtifactPath"], reward_decision_path)
        self.assertEqual(payload["trainingArtifacts"]["rewardDecisionId"], reward_decision_id)
        self.assertEqual(payload["trainingArtifacts"]["rewardDecisionArtifactPath"], reward_decision_path)
        self.assertEqual(payload["metricsFields"]["rewardDecisionId"], reward_decision_id)
        self.assertNotIn("REWARD_DECISION_ID_NULL", anomaly_codes)
        self.assertIn("E1_GATE_STALE", anomaly_codes)

    def test_training_ledger_clears_stale_e1_anomaly_when_selected_full_gate_is_fresh(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = root / "runtime-artifacts"
            output = root / "out" / "training-ledger.json"
            write_json(
                artifact_root / "rl-dataset-gates" / "e1-gate-20260605T191602Z" / "gate_report.json",
                {
                    "type": "screeps-rl-dataset-evaluation-gate",
                    "createdAt": "2026-06-05T19:16:02Z",
                    "ok": True,
                    "gateId": "e1-gate-20260605T191602Z",
                    "dataset": {"runId": "rl-fresh-full-e1", "sampleCount": 200},
                    "datasetGate": {"status": "pass", "sampleCount": 200},
                    "quality_checks": {"status": "pass", "samples_accepted": 200, "samples_rejected": 0},
                    "blockingReasons": [],
                },
            )
            write_json(
                artifact_root / "rl-control-loop" / "20260605T223000Z-training-ledger.json",
                {
                    "type": ledgers.TRAINING_LEDGER_TYPE,
                    "createdAt": "2026-06-05T22:30:00Z",
                    "status": "RUN_VALIDATED",
                    "trainingDidRun": True,
                    "e1Gate": {
                        "gateId": "e1-gate-20260603T045100Z",
                        "ok": True,
                        "datasetRunId": "rl-stale-full-e1",
                        "sampleCount": 200,
                    },
                    "environmentExecution": {"started": 80, "completed": 80, "failed": 0, "successRate": 1.0},
                    "iterationExecution": {
                        "simulatorTicksRequested": 160000,
                        "simulatorTicksRun": 160000,
                        "episodesRun": 80,
                        "candidateEvaluationIterations": 1,
                        "policyUpdateIterations": 1,
                    },
                    "trainingArtifacts": {
                        "trainingReportIds": ["training-report-current"],
                        "candidatePolicyIds": ["candidate-current"],
                    },
                    "metricsFields": {
                        "envCompleted": 80,
                        "ticksRun": 160000,
                        "episodes": 80,
                        "policyUpdateIterations": 1,
                        "trainingReportIds": ["training-report-current"],
                        "candidatePolicyId": "candidate-current",
                    },
                    "anomalies": [
                        {
                            "severity": "P2",
                            "code": "E1_GATE_STALE",
                            "evidence": "latest full E1 gate is e1-gate-20260603T045100Z",
                            "evidencePaths": [
                                "runtime-artifacts/rl-dataset-gates/e1-gate-20260603T045100Z/gate_report.json",
                            ],
                        },
                    ],
                },
            )

            exit_code = ledgers.main(
                [
                    "training-ledger",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T22:31:00Z",
                    "--max-files-per-root",
                    "8",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            payload = read_json(output)

        anomaly_codes = {item["code"] for item in payload["anomalies"]}
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["e1Gate"]["gateId"], "e1-gate-20260605T191602Z")
        self.assertTrue(payload["e1Gate"]["ok"])
        self.assertEqual(payload["e1Gate"]["sampleCount"], 200)
        self.assertNotIn("E1_GATE_STALE", anomaly_codes)

    def test_training_ledger_rejects_stale_policy_reward_decision_for_new_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root, report_id = write_root_local2w_training_report_artifacts(root, trusted_gradient_update=True)
            report_path = artifact_root / "rl-training" / f"{report_id}.json"
            report_payload = read_json(report_path)
            report_payload["anomalies"] = [{"severity": "P1", "code": "REWARD_DECISION_ID_NULL"}]
            write_json(report_path, report_payload)

            stale_reward_decision_id, stale_reward_decision_path = write_legacy_scorecard_reward_decision(
                root,
                artifact_root,
                scorecard_id="rl-scorecard-old-candidate",
                candidate_policy_id="old-candidate-policy",
            )
            write_json(
                artifact_root / "rl-control-loop" / "20260604T000001Z-policy-advantage.json",
                {
                    "type": ledgers.POLICY_ADVANTAGE_TYPE,
                    "createdAt": "2026-06-04T00:00:01Z",
                    "candidatePolicyId": "old-candidate-policy",
                    "baselinePolicyId": "incumbent",
                    "onlineUtilityStatus": "UNPROVEN",
                    "rewardDecisionId": stale_reward_decision_id,
                    "rewardDecisionArtifactPath": stale_reward_decision_path,
                    "scorecardId": "rl-scorecard-old-candidate",
                    "metrics": {},
                },
            )
            output = root / "out" / "training-ledger.json"

            exit_code = ledgers.main(
                [
                    "training-ledger",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T00:00:03Z",
                    "--max-files-per-root",
                    "4",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            payload = read_json(output)

        anomaly_codes = {item["code"] for item in payload["anomalies"]}
        self.assertEqual(exit_code, 0)
        self.assertIsNone(payload["rewardDecisionId"])
        self.assertIsNone(payload["rewardDecisionArtifactPath"])
        self.assertIsNone(payload["trainingArtifacts"]["rewardDecisionId"])
        self.assertIsNone(payload["metricsFields"]["rewardDecisionId"])
        self.assertIn("REWARD_DECISION_ID_NULL", anomaly_codes)

    def test_policy_advantage_output_is_bounded_and_artifact_first(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = write_fixture_artifacts(root)
            output = root / "out" / "policy-advantage.json"
            stdout = io.StringIO()
            stderr = io.StringIO()

            exit_code = ledgers.main(
                [
                    "policy-advantage",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T00:00:01Z",
                    "--stdout-bytes",
                    "180",
                ],
                stdout=stdout,
                stderr=stderr,
            )
            emitted = stdout.getvalue()
            artifact_exists = output.exists()
            payload = read_json(output)

        self.assertEqual(exit_code, 0)
        self.assertEqual(stderr.getvalue(), "")
        self.assertLessEqual(len(emitted.encode("utf-8")), 180)
        self.assertTrue(artifact_exists)
        self.assertEqual(payload["type"], ledgers.POLICY_ADVANTAGE_TYPE)
        self.assertEqual(payload["onlineUtilityStatus"], "UNPROVEN")
        self.assertEqual(payload["candidatePolicyId"], "candidate-a")
        self.assertEqual(json.loads(emitted)["artifact"], "out/policy-advantage.json")

    def test_policy_advantage_derives_evidence_fields_from_current_policy(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = root / "runtime-artifacts"
            write_json(
                artifact_root / "rl-control-loop" / "20260604T194548Z-policy-advantage.json",
                {
                    "type": ledgers.POLICY_ADVANTAGE_TYPE,
                    "createdAt": "2026-06-04T19:45:48Z",
                    "candidatePolicyId": "candidate-current",
                    "baselinePolicyId": "incumbent",
                    "onlineUtilityStatus": "PROVEN",
                    "deployabilityStatus": "READY_FOR_GATED_LIVE",
                    "metrics": {
                        "territory": {
                            "advantage": "advantage",
                            "candidateValue": 2,
                            "baselineValue": 1,
                            "delta": 1,
                        }
                    },
                    "regressions": [],
                },
            )
            write_json(
                artifact_root / "rl-control-loop" / "20260604T194549Z-policy-advantage.json",
                {
                    "type": ledgers.POLICY_ADVANTAGE_TYPE,
                    "createdAt": "2026-06-04T19:45:49Z",
                    "candidatePolicyId": "candidate-generated",
                    "baselinePolicyId": "incumbent",
                    "onlineUtilityStatus": "PROVEN",
                    "deployabilityStatus": "READY_FOR_GATED_LIVE",
                    "metrics": {
                        "territory": {
                            "advantage": "advantage",
                            "candidateValue": 3,
                            "baselineValue": 1,
                            "delta": 2,
                        }
                    },
                    "regressions": [],
                    "boundedProducer": {"maxFilesPerRoot": 4},
                },
            )
            output = root / "out" / "policy-advantage.json"

            exit_code = ledgers.main(
                [
                    "policy-advantage",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T00:00:01Z",
                    "--max-files-per-root",
                    "4",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            payload = read_json(output)

        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["candidatePolicyId"], "candidate-current")
        self.assertEqual(payload["onlineUtilityStatus"], "BLOCKED")
        self.assertEqual(payload["deployabilityStatus"], "BLOCKED")
        self.assertEqual(payload["metrics"]["territory"]["advantage"], "BLOCKED_NO_COMPUTE")
        self.assertEqual(payload["regressions"][0]["metric"], "territory")

    def test_policy_advantage_consumes_existing_legacy_scorecard_reward_decision(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root, _report_id = write_root_local2w_training_report_artifacts(root, trusted_gradient_update=True)
            candidate_policy_id = local2w_next_policy_id()
            scorecard_id = local2w_scorecard_id()
            reward_decision_id, reward_decision_path = write_legacy_scorecard_reward_decision(
                root,
                artifact_root,
                scorecard_id=scorecard_id,
                candidate_policy_id=candidate_policy_id,
            )
            write_json(
                artifact_root / "rl-control-loop" / "20260605T000001Z-policy-advantage.json",
                {
                    "type": ledgers.POLICY_ADVANTAGE_TYPE,
                    "createdAt": "2026-06-05T00:00:01Z",
                    "candidatePolicyId": candidate_policy_id,
                    "baselinePolicyId": "incumbent",
                    "onlineUtilityStatus": "UNPROVEN",
                    "rewardDecisionId": None,
                    "rewardDecisionArtifactPath": None,
                    "scorecardId": scorecard_id,
                    "metrics": {},
                },
            )
            output = root / "out" / "policy-advantage.json"

            exit_code = ledgers.main(
                [
                    "policy-advantage",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T00:00:02Z",
                    "--max-files-per-root",
                    "4",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            payload = read_json(output)

        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["rewardDecisionId"], reward_decision_id)
        self.assertEqual(payload["rewardDecisionArtifactPath"], reward_decision_path)

    def test_policy_advantage_recovers_scorecard_from_referenced_root_training_report(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root, report_id = write_root_local2w_training_report_artifacts(
                root,
                include_positive_policy=True,
                trusted_gradient_update=True,
            )
            candidate_policy_id = local2w_next_policy_id()
            write_json(
                artifact_root / "rl-control-loop" / "20260605T010000Z-training-ledger.json",
                {
                    "type": ledgers.TRAINING_LEDGER_TYPE,
                    "createdAt": "2026-06-05T01:00:00Z",
                    "status": "RUN_WITH_ANOMALY",
                    "trainingDidRun": True,
                    "environmentExecution": {"started": 80, "completed": 80, "failed": 0, "successRate": 1.0},
                    "iterationExecution": {
                        "simulatorTicksRequested": 160000,
                        "simulatorTicksRun": 160000,
                        "episodesRun": 80,
                        "candidateEvaluationIterations": 1,
                        "policyUpdateIterations": 1,
                    },
                    "trainingArtifacts": {
                        "trainingReportIds": [report_id],
                        "candidatePolicyIds": [candidate_policy_id],
                        "scorecardCount": 3,
                        "rewardDecisionId": None,
                        "rewardDecisionArtifactPath": None,
                    },
                    "metricsFields": {
                        "envCompleted": 80,
                        "ticksRun": 160000,
                        "episodes": 80,
                        "policyUpdateIterations": 1,
                        "trainingReportIds": [report_id],
                        "candidatePolicyId": candidate_policy_id,
                        "rewardDecisionId": None,
                    },
                    "anomalies": [{"severity": "P1", "code": "REWARD_DECISION_ID_NULL"}],
                },
            )
            output = root / "out" / "policy-advantage.json"

            exit_code = ledgers.main(
                [
                    "policy-advantage",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T01:01:00Z",
                    "--max-files-per-root",
                    "4",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            payload = read_json(output)
            decision = read_json(root / payload["rewardDecisionArtifactPath"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["candidatePolicyId"], candidate_policy_id)
        self.assertEqual(payload["scorecardId"], local2w_scorecard_id())
        self.assertIsNotNone(payload["rewardDecisionId"])
        self.assertEqual(decision["rewardDecisionId"], payload["rewardDecisionId"])
        self.assertEqual(decision["candidatePolicyId"], candidate_policy_id)
        self.assertEqual(decision["scorecardId"], local2w_scorecard_id())
        self.assertEqual(decision["validationEvidence"]["trustedGradientUpdate"], True)

    def test_policy_advantage_keeps_evidence_on_selected_ledger_report_when_latest_root_reuses_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root, report_id = write_root_local2w_training_report_artifacts(
                root,
                include_positive_policy=True,
                trusted_gradient_update=True,
            )
            candidate_policy_id = local2w_next_policy_id()
            unrelated_report_id = "unrelated-root-training-report-20260605T0030Z"
            reused_candidate_policy_id = candidate_policy_id
            unrelated_scorecard_path = (
                "runtime-artifacts/rl-training/candidate-scorecards/"
                f"{unrelated_report_id}/rl-scorecard-{unrelated_report_id}.json"
            )
            write_json(
                artifact_root / "rl-training" / f"{unrelated_report_id}.json",
                {
                    "type": "screeps-rl-training-report",
                    "schemaVersion": 1,
                    "generatedAt": "2026-06-05T00:30:00Z",
                    "status": "shadow",
                    "reportId": unrelated_report_id,
                    "artifactCount": 1,
                    "batchScale": {"environmentRows": 1, "simulatorTicks": 2000},
                    "simulation": {"repetitions": 1, "ticks": 2000, "workers": 1},
                    "source": {"simulatorRunCount": 1, "simulatorRunIds": [f"{unrelated_report_id}-r01"]},
                    "variantResults": [
                        {
                            "variantId": reused_candidate_policy_id,
                            "candidatePolicyId": reused_candidate_policy_id,
                            "ok": True,
                            "sampleCount": 1,
                        },
                    ],
                    "policyUpdateIterations": 1,
                    "trueGradient": True,
                    "trustedGradientUpdate": True,
                    "gradientStable": True,
                    "policyUpdateCandidatePolicyId": reused_candidate_policy_id,
                    "policyUpdate": {
                        "iterations": 1,
                        "nextCandidatePolicy": {"candidatePolicyId": reused_candidate_policy_id},
                    },
                    "scorecardId": f"rl-scorecard-{unrelated_report_id}",
                    "scorecardArtifactPath": unrelated_scorecard_path,
                    "candidateScorecard": {
                        "status": "ready",
                        "classification": "runtime_injected_candidate_scorecard_ready",
                        "scorecardId": f"rl-scorecard-{unrelated_report_id}",
                        "scorecardArtifactPath": unrelated_scorecard_path,
                        "candidateStrategyId": reused_candidate_policy_id,
                        "baselineStrategyId": "construction-priority.pg.incumbent-seed.v1",
                        "validationScaleComputeBlocked": False,
                        "scorecardUsable": True,
                    },
                },
            )
            write_json(
                artifact_root / "rl-control-loop" / "20260605T010000Z-training-ledger.json",
                {
                    "type": ledgers.TRAINING_LEDGER_TYPE,
                    "createdAt": "2026-06-05T01:00:00Z",
                    "status": "RUN_WITH_ANOMALY",
                    "trainingDidRun": True,
                    "environmentExecution": {"started": 80, "completed": 80, "failed": 0, "successRate": 1.0},
                    "iterationExecution": {
                        "simulatorTicksRequested": 160000,
                        "simulatorTicksRun": 160000,
                        "episodesRun": 80,
                        "candidateEvaluationIterations": 1,
                        "policyUpdateIterations": 1,
                    },
                    "trainingArtifacts": {
                        "trainingReportIds": [report_id],
                        "candidatePolicyIds": [candidate_policy_id],
                        "scorecardCount": 3,
                        "rewardDecisionId": None,
                        "rewardDecisionArtifactPath": None,
                    },
                    "metricsFields": {
                        "envCompleted": 80,
                        "ticksRun": 160000,
                        "episodes": 80,
                        "policyUpdateIterations": 1,
                        "trainingReportIds": [report_id],
                        "candidatePolicyId": candidate_policy_id,
                        "rewardDecisionId": None,
                    },
                    "anomalies": [{"severity": "P1", "code": "REWARD_DECISION_ID_NULL"}],
                },
            )
            output = root / "out" / "policy-advantage.json"

            exit_code = ledgers.main(
                [
                    "policy-advantage",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T01:02:00Z",
                    "--max-files-per-root",
                    "8",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            payload = read_json(output)
            decision = read_json(root / payload["rewardDecisionArtifactPath"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["candidatePolicyId"], candidate_policy_id)
        self.assertEqual(payload["scorecardId"], local2w_scorecard_id())
        self.assertEqual(payload["evidenceWindows"]["trainingReportIds"], [report_id])
        self.assertEqual(decision["linkedTrainingRuns"], [report_id])
        self.assertEqual(decision["validationEvidence"]["evidenceWindows"]["trainingReportIds"], [report_id])
        self.assertNotIn(unrelated_report_id, payload["evidenceWindows"]["trainingReportIds"])
        self.assertNotIn(unrelated_report_id, decision["linkedTrainingRuns"])
        self.assertNotIn(
            unrelated_report_id,
            decision["validationEvidence"]["evidenceWindows"]["trainingReportIds"],
        )

    def test_policy_evidence_windows_keeps_identityless_ledger_when_root_unmatched(self) -> None:
        selected_ledger = {
            "type": ledgers.TRAINING_LEDGER_TYPE,
            "status": "RUN_VALIDATED",
            "trainingDidRun": True,
            "trainingArtifacts": {"scorecardCount": 1},
            "metricsFields": {"envCompleted": 80},
        }
        latest_root_report = {
            "type": "screeps-rl-training-report",
            "trainingArtifacts": {"trainingReportIds": ["unrelated-root-report"]},
            "metricsFields": {
                "trainingReportIds": ["unrelated-root-report"],
                "candidatePolicyId": "unrelated-candidate",
            },
        }
        summary = {
            "artifacts": {
                "trainingLedger": "runtime-artifacts/rl-control-loop/selected-training-ledger.json",
                "policyAdvantage": "runtime-artifacts/rl-control-loop/policy-advantage.json",
            }
        }

        evidence_payload = ledgers.training_payload_for_evidence_windows(selected_ledger, latest_root_report)
        windows = ledgers.policy_evidence_windows(
            None,
            summary,
            {"identity": {"report": ["selected-dashboard-report"]}},
            Path("/repo"),
            evidence_payload,
        )

        self.assertIs(evidence_payload, selected_ledger)
        self.assertEqual(windows["trainingReportIds"], ["selected-dashboard-report"])
        self.assertNotIn("unrelated-root-report", windows["trainingReportIds"])

    def test_policy_advantage_scrubs_stale_reward_null_narrative_when_decision_recovered(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root, report_id = write_root_local2w_training_report_artifacts(root, trusted_gradient_update=True)
            candidate_policy_id = local2w_next_policy_id()
            reward_decision_id, reward_decision_path = write_legacy_scorecard_reward_decision(
                root,
                artifact_root,
                scorecard_id="legacy-selected-scorecard",
                candidate_policy_id=candidate_policy_id,
            )
            write_json(
                artifact_root / "rl-control-loop" / "20260605T010000Z-policy-advantage.json",
                {
                    "type": ledgers.POLICY_ADVANTAGE_TYPE,
                    "createdAt": "2026-06-05T01:00:00Z",
                    "candidatePolicyId": candidate_policy_id,
                    "baselinePolicyId": "incumbent",
                    "onlineUtilityStatus": "UNPROVEN",
                    "rewardDecisionId": None,
                    "rewardDecisionArtifactPath": None,
                    "metrics": {},
                    "evidenceWindows": {
                        "trainingReportIds": [
                            f"{report_id} (RUN_WITH_ANOMALY: trueGradient=true, rewardDecisionId=null)",
                        ],
                    },
                    "rolloutGate": {
                        "status": "BLOCKED",
                        "reason": (
                            "rewardDecisionId is null; local fallback card fix and a fresh training pass are still "
                            "required."
                        ),
                        "source": "reward_decision_generation",
                    },
                    "nextExperimentCardDelta": (
                        "(1) FIX experiment card path. "
                        "(2) RESTORE rewardDecisionId provenance \u2014 investigate why latest ledger shows null. "
                        "(3) RESOLVE Tencent blocked."
                    ),
                    "trainingStrategyFeedback": {
                        "rewardChanges": (
                            "CRITICAL REGRESSION: rewardDecisionId=null in latest training ledger. "
                            "The null value breaks downstream consumers."
                        ),
                        "scenarioChanges": [],
                        "dataWeightingChanges": [],
                        "frameworkInstrumentationChanges": [],
                        "candidateGenerationChanges": [],
                    },
                },
            )
            write_json(
                artifact_root / "rl-control-loop" / "20260605T010100Z-training-ledger-read-only-preflight.json",
                {
                    "kind": "rl_training_ledger_read_only_preflight",
                    "parsed": {"type": "screeps-rl-batch-preflight-context"},
                    "raw": {"ok": True, "returncode": 0},
                    "script": "preflight.py",
                },
            )
            output = root / "out" / "policy-advantage.json"

            exit_code = ledgers.main(
                [
                    "policy-advantage",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T01:02:00Z",
                    "--max-files-per-root",
                    "4",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            payload = read_json(output)

        checked_text = json.dumps(
            {
                "nextExperimentCardDelta": payload["nextExperimentCardDelta"],
                "rolloutGate": payload["rolloutGate"],
                "evidenceWindows": payload["evidenceWindows"],
                "trainingStrategyFeedback": payload["trainingStrategyFeedback"],
            },
            sort_keys=True,
        )
        regression_metrics = {item["metric"] for item in payload["regressions"]}
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["rewardDecisionId"], reward_decision_id)
        self.assertEqual(payload["rewardDecisionArtifactPath"], reward_decision_path)
        self.assertEqual(payload["deployabilityStatus"], "BLOCKED")
        self.assertEqual(payload["evidenceWindows"]["trainingReportIds"], [report_id])
        self.assertEqual(payload["rolloutGate"]["status"], "BLOCKED")
        self.assertIn(
            f"rewardDecisionId {reward_decision_id} is available",
            payload["rolloutGate"]["reason"],
        )
        self.assertNotIn("rewardDecisionId_null_regression", regression_metrics)
        self.assertNotIn("rewardDecisionId_missing", regression_metrics)
        for marker in ledgers.REWARD_DECISION_NULL_TEXT_MARKERS:
            self.assertNotIn(marker, checked_text)

    def test_policy_advantage_emits_reward_decision_for_trusted_selected_scorecard(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root, report_id = write_root_local2w_training_report_artifacts(
                root,
                include_positive_policy=True,
                trusted_gradient_update=True,
            )
            output = root / "out" / "policy-advantage.json"

            exit_code = ledgers.main(
                [
                    "policy-advantage",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T00:00:01Z",
                    "--max-files-per-root",
                    "4",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            payload = read_json(output)
            decision = read_json(root / payload["rewardDecisionArtifactPath"])

        self.assertEqual(exit_code, 0)
        self.assertIsNotNone(payload["rewardDecisionId"])
        self.assertEqual(payload["rewardDecisionId"], decision["rewardDecisionId"])
        self.assertEqual(decision["decisionType"], "change")
        self.assertEqual(decision["sourceIssue"], 1690)
        self.assertEqual(decision["relatedIssues"], [907, 924])
        self.assertEqual(decision["scorecardId"], payload["scorecardId"])
        self.assertEqual(decision["candidatePolicyId"], payload["candidatePolicyId"])
        self.assertEqual(decision["validationEvidence"]["trustedGradientUpdate"], True)
        self.assertEqual(decision["linkedArtifactPaths"]["policyAdvantageArtifactPath"], "out/policy-advantage.json")
        self.assertEqual(decision["linkedTrainingRuns"], [report_id])
        self.assertIn("runtime-artifacts/rl-training/candidate-scorecards", decision["linkedArtifactPaths"]["scorecardArtifactPath"])

    def test_policy_advantage_scrubs_emitted_decision_rollout_gate_from_stale_previous_null_reason(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root, report_id = write_root_local2w_training_report_artifacts(
                root,
                include_positive_policy=True,
                trusted_gradient_update=True,
            )
            candidate_policy_id = local2w_next_policy_id()
            output = root / "out" / "policy-advantage.json"
            write_json(
                artifact_root / "rl-control-loop" / "20260604T230000Z-policy-advantage.json",
                {
                    "type": ledgers.POLICY_ADVANTAGE_TYPE,
                    "createdAt": "2026-06-04T23:00:00Z",
                    "candidatePolicyId": candidate_policy_id,
                    "baselinePolicyId": "incumbent",
                    "onlineUtilityStatus": "PROVEN",
                    "metrics": {
                        "territory": {"advantage": "advantage", "candidateValue": 2, "baselineValue": 1, "delta": 1},
                        "resources": {"advantage": "tie", "candidateValue": 1, "baselineValue": 1, "delta": 0},
                    },
                    "regressions": [],
                    "evidenceWindows": {"trainingReportIds": [report_id]},
                    "rolloutGate": {
                        "status": "BLOCKED",
                        "reason": "rewardDecisionId is null; preserve the previous blocker until provenance is restored.",
                        "source": "reward_decision_generation",
                    },
                },
            )

            exit_code = ledgers.main(
                [
                    "policy-advantage",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T00:00:01Z",
                    "--max-files-per-root",
                    "4",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            payload = read_json(output)
            decision = read_json(root / payload["rewardDecisionArtifactPath"])

        decision_rollout_gate = decision["validationEvidence"]["rolloutGate"]
        gate_text = json.dumps(decision_rollout_gate, sort_keys=True)
        self.assertEqual(exit_code, 0)
        self.assertIsNotNone(payload["rewardDecisionId"])
        self.assertEqual(decision["rewardDecisionId"], payload["rewardDecisionId"])
        self.assertEqual(payload["rolloutGate"], decision_rollout_gate)
        self.assertIn(f"rewardDecisionId {payload['rewardDecisionId']} is available", decision_rollout_gate["reason"])
        for marker in ledgers.REWARD_DECISION_NULL_TEXT_MARKERS:
            self.assertNotIn(marker, gate_text)

    def test_policy_advantage_keeps_untrusted_root_training_report_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root, report_id = write_root_local2w_training_report_artifacts(root, include_positive_policy=True)
            output = root / "out" / "policy-advantage.json"

            exit_code = ledgers.main(
                [
                    "policy-advantage",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T00:00:01Z",
                    "--max-files-per-root",
                    "4",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            payload = read_json(output)
            decision = read_json(root / payload["rewardDecisionArtifactPath"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["onlineUtilityStatus"], "BLOCKED")
        self.assertEqual(payload["deployabilityStatus"], "BLOCKED")
        self.assertEqual(payload["rolloutGate"]["status"], "BLOCKED")
        self.assertEqual(payload["rolloutGate"]["reason"], "training report marks trustedGradientUpdate=false")
        self.assertEqual(payload["evidenceWindows"]["trainingReportIds"], [report_id])
        self.assertTrue(payload["evidenceWindows"]["latestTrainingLedger"].endswith(f"{report_id}.json"))
        self.assertIsNotNone(payload["rewardDecisionId"])
        self.assertTrue(payload["rewardDecisionArtifactPath"].endswith(f"{payload['rewardDecisionId']}.json"))
        self.assertEqual(decision["rewardDecisionId"], payload["rewardDecisionId"])
        self.assertEqual(decision["decisionType"], "hold")
        self.assertEqual(decision["validationEvidence"]["trustedGradientUpdate"], False)
        self.assertIn("Hold while trustedGradientUpdate is not true.", decision["holdCriteria"])

    def test_policy_advantage_refreshes_reward_decision_when_scorecard_becomes_trusted(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root, report_id = write_root_local2w_training_report_artifacts(
                root,
                include_positive_policy=True,
            )
            first_output = artifact_root / "rl-control-loop" / "20260605T000001Z-policy-advantage.json"

            first_exit = ledgers.main(
                [
                    "policy-advantage",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(first_output),
                    "--created-at",
                    "2026-06-05T00:00:01Z",
                    "--max-files-per-root",
                    "4",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            first_payload = read_json(first_output)
            first_decision = read_json(root / first_payload["rewardDecisionArtifactPath"])

            write_root_local2w_training_report_artifacts(
                root,
                include_positive_policy=False,
                trusted_gradient_update=True,
            )
            second_output = artifact_root / "rl-control-loop" / "20260605T000101Z-policy-advantage.json"

            second_exit = ledgers.main(
                [
                    "policy-advantage",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(second_output),
                    "--created-at",
                    "2026-06-05T00:01:01Z",
                    "--max-files-per-root",
                    "4",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            second_payload = read_json(second_output)
            refreshed_decision = read_json(root / second_payload["rewardDecisionArtifactPath"])

        self.assertEqual(first_exit, 0)
        self.assertEqual(second_exit, 0)
        self.assertEqual(first_payload["rewardDecisionId"], second_payload["rewardDecisionId"])
        self.assertEqual(
            first_payload["rewardDecisionArtifactPath"],
            second_payload["rewardDecisionArtifactPath"],
        )
        self.assertEqual(first_decision["decisionType"], "hold")
        self.assertEqual(first_decision["validationEvidence"]["trustedGradientUpdate"], False)
        self.assertEqual(refreshed_decision["rewardDecisionId"], second_payload["rewardDecisionId"])
        self.assertEqual(refreshed_decision["decisionType"], "change")
        self.assertEqual(refreshed_decision["decisionDisposition"], "change")
        self.assertEqual(refreshed_decision["validationEvidence"]["trustedGradientUpdate"], True)
        self.assertEqual(refreshed_decision["validationEvidence"]["gradientStable"], True)
        self.assertEqual(refreshed_decision["linkedTrainingRuns"], [report_id])
        self.assertEqual(
            refreshed_decision["linkedArtifactPaths"]["policyAdvantageArtifactPath"],
            "runtime-artifacts/rl-control-loop/20260605T000101Z-policy-advantage.json",
        )
        self.assertEqual(refreshed_decision["createdAt"], "2026-06-05T00:00:01Z")
        self.assertEqual(refreshed_decision["updatedAt"], "2026-06-05T00:01:01Z")

    def test_policy_advantage_does_not_emit_reward_decision_without_scorecard_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = write_fixture_artifacts(root)
            output = root / "out" / "policy-advantage.json"

            exit_code = ledgers.main(
                [
                    "policy-advantage",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T00:00:01Z",
                    "--max-files-per-root",
                    "4",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            payload = read_json(output)
            decision_dir_exists = (artifact_root / "rl-control-loop" / "reward-decisions").exists()

        self.assertEqual(exit_code, 0)
        self.assertIsNone(payload["rewardDecisionId"])
        self.assertIsNone(payload["rewardDecisionArtifactPath"])
        self.assertIsNone(payload["scorecardId"])
        self.assertEqual(payload["deployabilityStatus"], "BLOCKED")
        self.assertIn("rewardDecisionId_missing", {item["metric"] for item in payload["regressions"]})
        self.assertFalse(decision_dir_exists)

    def test_steward_digest_uses_bounded_scan_without_github_side_effects(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = write_fixture_artifacts(root)
            output = root / "out" / "steward-digest.json"

            exit_code = ledgers.main(
                [
                    "steward-digest",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T00:00:02Z",
                    "--max-files-per-root",
                    "4",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            payload = read_json(output)

        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["type"], ledgers.STEWARD_DIGEST_TYPE)
        self.assertEqual(payload["githubComment"], "skipped_no_atomic_issue")
        self.assertIn("lanes", payload)
        self.assertIn("boundedProducer", payload)

    def test_steward_digest_surfaces_unlinked_open_conclusion_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = write_fixture_artifacts(root)
            write_json(
                artifact_root / "rl-control-loop" / "conclusion-registry.json",
                {
                    "schemaVersion": 1,
                    "registryType": "rl-conclusion-registry",
                    "conclusions": {
                        "P1-UNLINKED": {
                            "conclusionId": "P1-UNLINKED",
                            "status": "OPEN",
                            "severity": "P1",
                            "linkedIssues": [],
                        }
                    },
                },
            )
            output = root / "out" / "steward-digest.json"

            exit_code = ledgers.main(
                [
                    "steward-digest",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T00:00:02Z",
                    "--max-files-per-root",
                    "4",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            payload = read_json(output)

        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["status"], "ACTION_REQUIRED")
        self.assertEqual(payload["linkedIssueGate"]["status"], "ACTION_REQUIRED")
        self.assertEqual(payload["linkedIssueGate"]["blockedConclusionCount"], 1)
        self.assertEqual(payload["linkedIssueGate"]["highestPriorityConclusionIds"], ["P1-UNLINKED"])
        self.assertIn("exact atomic linkedIssues", payload["nextAction"])

    def test_steward_digest_blocks_on_malformed_conclusion_registry(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = write_fixture_artifacts(root)
            write_json(
                artifact_root / "rl-control-loop" / "conclusion-registry.json",
                {
                    "schemaVersion": 1,
                    "registryType": "rl-conclusion-registry",
                    "updatedAt": "2026-06-05T00:00:01Z",
                    "conclusions": ["not-a-conclusion-record"],
                },
            )
            output = root / "out" / "steward-digest.json"

            exit_code = ledgers.main(
                [
                    "steward-digest",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T00:00:02Z",
                    "--max-files-per-root",
                    "4",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            payload = read_json(output)

        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["status"], "ACTION_REQUIRED")
        self.assertEqual(payload["linkedIssueGate"]["status"], "INVALID_REGISTRY")
        self.assertFalse(payload["linkedIssueGate"]["ok"])
        self.assertEqual(
            payload["linkedIssueGate"]["projectEvidence"]["status"],
            "BLOCKED_INVALID_CONCLUSION_REGISTRY",
        )
        self.assertIn("Repair conclusion-registry.json", payload["nextAction"])
        self.assertIn("each conclusion record", payload["linkedIssueGate"]["error"])

    def test_linked_issues_check_blocks_when_registry_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = root / "runtime-artifacts"
            output = root / "out" / "linked-issues-check.json"
            stdout = io.StringIO()
            stderr = io.StringIO()

            exit_code = ledgers.main(
                [
                    "linked-issues-check",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-07T00:00:00Z",
                ],
                stdout=stdout,
                stderr=stderr,
            )
            payload = read_json(output)
            emitted = json.loads(stdout.getvalue())

        self.assertEqual(exit_code, 2)
        self.assertEqual(stderr.getvalue(), "")
        self.assertFalse(emitted["ok"])
        self.assertEqual(emitted["status"], "BLOCKED")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["status"], "BLOCKED")
        self.assertEqual(payload["exitCode"], 2)
        self.assertFalse(payload["registryLoaded"])
        self.assertIn("missing conclusion-registry.json", payload["registryError"])
        self.assertEqual(payload["linkedIssueGate"]["status"], "INVALID_REGISTRY")
        self.assertFalse(payload["linkedIssueGate"]["ok"])
        self.assertIn("missing conclusion-registry.json", payload["linkedIssueGate"]["error"])
        self.assertEqual(
            payload["projectEvidence"]["status"],
            "BLOCKED_INVALID_CONCLUSION_REGISTRY",
        )
        self.assertIn("missing conclusion-registry.json", payload["projectEvidence"]["evidence"])

    def test_linked_issues_check_writes_artifact_and_fails_for_unlinked_open_p1(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = root / "runtime-artifacts"
            write_json(
                artifact_root / "rl-control-loop" / "conclusion-registry.json",
                {
                    "schemaVersion": 1,
                    "registryType": "rl-conclusion-registry",
                    "conclusions": {
                        "L20260606T160607Z-LOOP_B-ENERGY_BUFFER_COLLAPSE": {
                            "conclusionId": "L20260606T160607Z-LOOP_B-ENERGY_BUFFER_COLLAPSE",
                            "status": "OPEN",
                            "severity": "P1",
                            "category": "economy",
                            "linkedIssues": [],
                            "statement": "Energy buffer collapse lacks an atomic issue.",
                        }
                    },
                },
            )
            output = root / "out" / "linked-issues-check.json"
            stdout = io.StringIO()
            stderr = io.StringIO()

            exit_code = ledgers.main(
                [
                    "linked-issues-check",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-07T00:00:00Z",
                ],
                stdout=stdout,
                stderr=stderr,
            )
            payload = read_json(output)
            emitted = json.loads(stdout.getvalue())

        self.assertEqual(exit_code, 2)
        self.assertEqual(stderr.getvalue(), "")
        self.assertFalse(emitted["ok"])
        self.assertEqual(emitted["type"], ledgers.CONCLUSION_LINKED_ISSUES_CHECK_TYPE)
        self.assertEqual(emitted["status"], "BLOCKED")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["type"], ledgers.CONCLUSION_LINKED_ISSUES_CHECK_TYPE)
        self.assertEqual(payload["status"], "BLOCKED")
        self.assertEqual(payload["exitCode"], 2)
        self.assertEqual(payload["githubComment"], "skipped_no_atomic_issue")
        self.assertNotIn("historicalContextIssues", payload)
        self.assertEqual(payload["linkedIssueGate"]["status"], "ACTION_REQUIRED")
        self.assertEqual(payload["linkedIssueGate"]["blockedConclusionCount"], 1)
        self.assertEqual(
            payload["linkedIssueGate"]["highestPriorityConclusionIds"],
            ["L20260606T160607Z-LOOP_B-ENERGY_BUFFER_COLLAPSE"],
        )
        self.assertEqual(
            payload["projectEvidence"]["status"],
            "BLOCKED_MISSING_LINKED_ISSUES",
        )

    def test_linked_issues_check_accepts_linked_and_non_blocking_conclusions(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = root / "runtime-artifacts"
            write_json(
                artifact_root / "rl-control-loop" / "conclusion-registry.json",
                {
                    "schemaVersion": 1,
                    "registryType": "rl-conclusion-registry",
                    "entries": [
                        {
                            "conclusionId": "P1-LINKED",
                            "status": "OPEN",
                            "severity": "P1",
                            "linkedIssues": ["#1748"],
                        },
                        {
                            "conclusionId": "P2-CLOSED-UNLINKED",
                            "status": "CLOSED",
                            "severity": "P2",
                        },
                        {
                            "conclusionId": "P3-OPEN-UNLINKED",
                            "status": "OPEN",
                            "severity": "P3",
                        },
                    ],
                },
            )
            output = root / "out" / "linked-issues-check.json"

            exit_code = ledgers.main(
                [
                    "linked-issues-check",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-07T00:00:00Z",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            payload = read_json(output)

        self.assertEqual(exit_code, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["status"], "OK")
        self.assertEqual(payload["linkedIssueGate"]["blockedConclusionCount"], 0)
        self.assertEqual(payload["projectEvidence"]["nextAction"], "No unlinked OPEN P0/P1/P2 conclusions.")

    def test_steward_digest_sees_root_level_training_report_and_blocks_missing_registry(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root, report_id = write_root_local2w_training_report_artifacts(root)
            output = root / "out" / "steward-digest.json"

            exit_code = ledgers.main(
                [
                    "steward-digest",
                    "--repo-root",
                    str(root),
                    "--artifact-root",
                    str(artifact_root),
                    "--output",
                    str(output),
                    "--created-at",
                    "2026-06-05T00:00:02Z",
                    "--max-files-per-root",
                    "4",
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
            )
            payload = read_json(output)

        lanes = {item["name"]: item for item in payload["lanes"]}
        blocked_lane_names = {item["name"] for item in payload["blockedLanes"]}
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["status"], "ACTION_REQUIRED")
        self.assertEqual(payload["linkedIssueGate"]["status"], "INVALID_REGISTRY")
        self.assertIn("missing conclusion-registry artifact", payload["linkedIssueGate"]["error"])
        self.assertEqual(lanes["training"]["status"], "OK")
        self.assertTrue(str(lanes["training"]["latestArtifact"]).endswith(f"{report_id}.json"))
        self.assertIn("strategy comparison", blocked_lane_names)
        self.assertIn("rollout", blocked_lane_names)
        self.assertIn("Repair conclusion-registry.json", payload["nextAction"])


if __name__ == "__main__":
    unittest.main()
