#!/usr/bin/env python3
from __future__ import annotations

import copy
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import screeps_rl_dataset_export as dataset_export
import screeps_strategy_shadow_report as shadow_report


REPO_ROOT = Path(__file__).resolve().parents[1]


def runtime_line(payload: dict[str, object]) -> str:
    return f"#runtime-summary {json.dumps(payload, sort_keys=True)}\n"


def read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def replay_payload(tick: int = 200, secret_suffix: str = "") -> dict[str, object]:
    remote_label = "build remote road/container logistics"
    if secret_suffix:
        remote_label = f"{remote_label} {secret_suffix}"
    return {
        "type": "runtime-summary",
        "tick": tick,
        "rooms": [
            {
                "roomName": "E26S49",
                "energyAvailable": 350,
                "energyCapacity": 550,
                "workerCount": 4,
                "spawnStatus": [{"name": "Spawn1", "status": "idle"}],
                "controller": {
                    "level": 3,
                    "progress": 12000,
                    "progressTotal": 135000,
                    "ticksToDowngrade": 8000,
                },
                "resources": {
                    "storedEnergy": 420,
                    "workerCarriedEnergy": 120,
                    "droppedEnergy": 30,
                    "sourceCount": 2,
                    "events": {"harvestedEnergy": 80, "transferredEnergy": 65},
                },
                "combat": {
                    "hostileCreepCount": 0,
                    "hostileStructureCount": 0,
                    "events": {
                        "attackCount": 0,
                        "attackDamage": 0,
                        "objectDestroyedCount": 0,
                        "creepDestroyedCount": 0,
                    },
                },
                "constructionPriority": {
                    "candidates": [
                        {
                            "buildItem": "build extension capacity",
                            "room": "E26S49",
                            "score": 70,
                            "urgency": "high",
                            "preconditions": [],
                            "expectedKpiMovement": [
                                "raises spawn energy capacity",
                                "unlocks larger workers and faster RCL progress",
                            ],
                            "risk": ["adds build backlog before roads/containers if worker capacity is low"],
                        },
                        {
                            "buildItem": remote_label,
                            "room": "E26S49",
                            "score": 62,
                            "urgency": "medium",
                            "preconditions": [],
                            "expectedKpiMovement": [
                                "opens remote territory route",
                                "supports reserve room economy",
                                "improves harvest throughput",
                            ],
                            "risk": [],
                        },
                        {
                            "buildItem": "build rampart defense",
                            "room": "E26S49",
                            "score": 45,
                            "urgency": "medium",
                            "preconditions": [],
                            "expectedKpiMovement": ["improves spawn/controller survivability under pressure"],
                            "risk": ["decays without sustained repair budget"],
                        },
                    ],
                    "nextPrimary": {
                        "buildItem": "build extension capacity",
                        "room": "E26S49",
                        "score": 70,
                        "urgency": "high",
                        "preconditions": [],
                        "expectedKpiMovement": [
                            "raises spawn energy capacity",
                            "unlocks larger workers and faster RCL progress",
                        ],
                        "risk": ["adds build backlog before roads/containers if worker capacity is low"],
                    },
                },
                "territoryRecommendation": {
                    "candidates": [
                        {
                            "roomName": "E48S27",
                            "action": "reserve",
                            "score": 850,
                            "evidenceStatus": "sufficient",
                            "source": "configured",
                            "evidence": ["room visible", "controller is available", "2 sources visible"],
                            "preconditions": [],
                            "risks": [],
                            "routeDistance": 2,
                            "sourceCount": 2,
                        },
                        {
                            "roomName": "E49S28",
                            "action": "occupy",
                            "score": 820,
                            "evidenceStatus": "sufficient",
                            "source": "configured",
                            "evidence": ["room visible", "controller is available", "1 source visible"],
                            "preconditions": [],
                            "risks": [],
                            "routeDistance": 1,
                            "sourceCount": 1,
                        },
                    ],
                    "next": {
                        "roomName": "E48S27",
                        "action": "reserve",
                        "score": 850,
                        "evidenceStatus": "sufficient",
                        "source": "configured",
                        "evidence": ["room visible", "controller is available", "2 sources visible"],
                        "preconditions": [],
                        "risks": [],
                        "routeDistance": 2,
                        "sourceCount": 2,
                    },
                },
            }
        ],
        "cpu": {"used": 5.2, "bucket": 9000},
    }


class StrategyShadowReportTest(unittest.TestCase):
    def test_generates_bounded_offline_report_with_safety_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "runtime.log"
            artifact.write_text(runtime_line(replay_payload()), encoding="utf-8")
            out_dir = root / "strategy-shadow"

            summary = shadow_report.build_strategy_shadow_report(
                [str(artifact)],
                out_dir,
                report_id="shadow-test",
                generated_at="2026-05-01T00:00:00Z",
                bot_commit="a" * 40,
                repo_root=REPO_ROOT,
            )
            report = read_json(out_dir / "shadow-test.json")

        self.assertTrue(summary["ok"])
        self.assertFalse(summary["liveEffect"])
        self.assertEqual(report["type"], "screeps-strategy-shadow-report")
        self.assertFalse(report["liveEffect"])
        self.assertFalse(report["safety"]["liveApiCalls"])
        self.assertFalse(report["safety"]["officialMmoWritesAllowed"])
        self.assertFalse(report["safety"]["memoryWritesAllowed"])
        self.assertFalse(report["safety"]["creepSpawnMarketIntentsAllowed"])
        self.assertEqual(report["artifactCount"], 1)
        self.assertGreaterEqual(report["rankingDiffCount"], 2)
        self.assertGreaterEqual(report["changedTopCount"], 2)
        self.assertEqual(
            report["candidateStrategyIds"],
            ["construction-priority.territory-shadow.v1", "expansion-remote.territory-shadow.v1"],
        )
        self.assertEqual(report["source"]["sourceCount"], 1)
        self.assertEqual(report["source"]["evaluatedArtifactCount"], 1)
        self.assertIn("sha256", report["source"]["sourceFiles"][0])
        self.assertIn("kpiSummary", report)
        self.assertNotIn("#runtime-summary", json.dumps(report, sort_keys=True))

    def test_defaults_are_repo_root_anchored_from_non_repo_cwd_and_exclude_output_dir(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fake_repo = root / "repo"
            scheduler_cwd = root / "scheduler"
            runtime_root = fake_repo / "runtime-artifacts"
            out_dir = runtime_root / "strategy-shadow"
            dist_path = fake_repo / "prod" / "dist" / "main.js"
            scheduler_cwd.mkdir()
            runtime_root.mkdir(parents=True)
            out_dir.mkdir()
            dist_path.parent.mkdir(parents=True)
            dist_path.write_text("module.exports = {};\n", encoding="utf-8")
            artifact = runtime_root / "runtime.log"
            artifact.write_text(runtime_line(replay_payload(300)), encoding="utf-8")
            prior_output = out_dir / "prior-report.log"
            prior_output.write_text(runtime_line(replay_payload(999)), encoding="utf-8")

            evaluator_report = {
                "enabled": True,
                "artifactCount": 1,
                "modelReports": [],
                "warnings": [],
            }
            previous_cwd = Path.cwd()
            try:
                os.chdir(scheduler_cwd)
                with (
                    mock.patch.object(shadow_report, "default_repo_root", return_value=fake_repo),
                    mock.patch.object(dataset_export, "DEFAULT_INPUT_PATHS", ("runtime-artifacts",)),
                    mock.patch.object(
                        shadow_report,
                        "run_shadow_evaluator",
                        return_value=evaluator_report,
                    ) as evaluator,
                ):
                    summary = shadow_report.build_strategy_shadow_report(
                        [],
                        report_id="default-paths",
                        generated_at="2026-05-01T00:00:00Z",
                        bot_commit="d" * 40,
                    )
            finally:
                os.chdir(previous_cwd)

            report = read_json(out_dir / "default-paths.json")

        self.assertTrue(summary["ok"])
        self.assertFalse((scheduler_cwd / "runtime-artifacts").exists())
        self.assertEqual(evaluator.call_args.args[0], dist_path.resolve())
        self.assertEqual([artifact["tick"] for artifact in evaluator.call_args.args[1]], [300])
        self.assertEqual(report["source"]["parsedRuntimeArtifactCount"], 1)
        self.assertEqual(report["source"]["sourceCount"], 1)
        self.assertEqual(report["source"]["artifacts"][0]["tick"], 300)

    def test_bounds_diff_samples_and_redacts_configured_secret_values(self) -> None:
        secret = "supersecret123456"
        payloads = [replay_payload(200, secret), replay_payload(201, secret), replay_payload(202, secret)]

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "runtime.log"
            artifact.write_text("".join(runtime_line(copy.deepcopy(payload)) for payload in payloads), encoding="utf-8")
            out_dir = root / "strategy-shadow"

            with mock.patch.dict(os.environ, {"SCREEPS_AUTH_TOKEN": secret}):
                shadow_report.build_strategy_shadow_report(
                    [str(artifact)],
                    out_dir,
                    report_id="shadow-bounds",
                    generated_at="2026-05-01T00:00:00Z",
                    bot_commit="b" * 40,
                    artifact_limit=2,
                    max_ranking_diff_samples=1,
                    repo_root=REPO_ROOT,
                )
            report_path = out_dir / "shadow-bounds.json"
            report = read_json(report_path)
            report_text = report_path.read_text(encoding="utf-8")

        self.assertNotIn(secret, report_text)
        self.assertNotIn("#runtime-summary", report_text)
        self.assertEqual(report["source"]["parsedRuntimeArtifactCount"], 3)
        self.assertEqual(report["source"]["evaluatedArtifactCount"], 2)
        self.assertTrue(report["source"]["artifactLimitApplied"])
        self.assertTrue(any("artifact limit applied" in warning for warning in report["warnings"]))
        for model_report in report["modelReports"]:
            self.assertLessEqual(len(model_report["rankingDiffs"]), 1)
            if model_report["rankingDiffCount"] > 1:
                self.assertTrue(model_report["rankingDiffsTruncated"])

    def test_cli_output_is_compact_and_dataset_export_indexes_generated_report(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "runtime.log"
            artifact.write_text(runtime_line(replay_payload()), encoding="utf-8")
            report_dir = root / "strategy-shadow"
            stdout = io.StringIO()

            exit_code = shadow_report.main(
                [
                    str(artifact),
                    "--out-dir",
                    str(report_dir),
                    "--report-id",
                    "shadow-cli",
                    "--bot-commit",
                    "c" * 40,
                ],
                stdout=stdout,
            )
            cli_output = stdout.getvalue()
            dataset_dir = root / "datasets"
            summary = dataset_export.build_dataset(
                [str(artifact), str(report_dir / "shadow-cli.json")],
                dataset_dir,
                run_id="shadow-dataset",
                bot_commit="c" * 40,
                eval_ratio_value=0,
                repo_root=REPO_ROOT,
            )
            run_manifest = read_json(dataset_dir / "shadow-dataset" / "run_manifest.json")

        self.assertEqual(exit_code, 0)
        self.assertNotIn("#runtime-summary", cli_output)
        self.assertIn("reportPath", cli_output)
        self.assertEqual(summary["strategyShadowReportCount"], 1)
        shadow_metadata = run_manifest["strategy"]["shadowReports"][0]
        self.assertEqual(shadow_metadata["rankingDiffCount"], 2)
        self.assertEqual(shadow_metadata["changedTopCount"], 2)
        self.assertEqual(
            shadow_metadata["candidateStrategyIds"],
            ["construction-priority.territory-shadow.v1", "expansion-remote.territory-shadow.v1"],
        )
        self.assertNotIn("rankingDiffs", shadow_metadata)


if __name__ == "__main__":
    unittest.main()
