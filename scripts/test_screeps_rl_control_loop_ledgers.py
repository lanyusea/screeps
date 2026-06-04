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


if __name__ == "__main__":
    unittest.main()
