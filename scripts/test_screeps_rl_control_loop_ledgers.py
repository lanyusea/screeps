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


def write_root_local2w_training_report_artifacts(root: Path, *, include_positive_policy: bool = False) -> tuple[Path, str]:
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
                "status": "blocked_gradient_stability_untrusted",
                "runtimeParameterConsumption": True,
                "trustedGradientUpdate": False,
                "gradientStable": False,
                "reason": "true-gradient estimate conflicts with momentum direction",
            },
            "trustedGradientUpdate": False,
            "gradientStable": False,
            "scorecardId": f"rl-scorecard-{LOCAL2W_REPORT_ID}-187e0c0e1786",
            "scorecardArtifactPath": (
                "runtime-artifacts/rl-training/candidate-scorecards/"
                f"{LOCAL2W_REPORT_ID}/rl-scorecard-{LOCAL2W_REPORT_ID}-187e0c0e1786.json"
            ),
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


class ScreepsRlControlLoopLedgersTest(unittest.TestCase):
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

        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["onlineUtilityStatus"], "BLOCKED")
        self.assertEqual(payload["deployabilityStatus"], "BLOCKED")
        self.assertEqual(payload["rolloutGate"]["status"], "BLOCKED")
        self.assertEqual(payload["rolloutGate"]["reason"], "training report marks trustedGradientUpdate=false")
        self.assertEqual(payload["evidenceWindows"]["trainingReportIds"], [report_id])
        self.assertTrue(payload["evidenceWindows"]["latestTrainingLedger"].endswith(f"{report_id}.json"))

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

    def test_steward_digest_sees_root_level_training_report_but_keeps_rollout_blocked(self) -> None:
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
        self.assertEqual(lanes["training"]["status"], "OK")
        self.assertTrue(str(lanes["training"]["latestArtifact"]).endswith(f"{report_id}.json"))
        self.assertIn("strategy comparison", blocked_lane_names)
        self.assertIn("rollout", blocked_lane_names)


if __name__ == "__main__":
    unittest.main()
