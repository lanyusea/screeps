#!/usr/bin/env python3
from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))

import screeps_rl_metrics_ingestor as ingestor


JsonObject = dict[str, Any]


def runtime_line(payload: JsonObject) -> str:
    return f"#runtime-summary {json.dumps(payload, sort_keys=True)}\n"


def write_runtime_artifact(root: Path, payload: JsonObject, name: str = "runtime.log") -> Path:
    artifact_dir = root / "runtime-summary-console"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    artifact = artifact_dir / name
    artifact.write_text(runtime_line(payload), encoding="utf-8")
    return artifact_dir


def fetch_count(db_path: Path, table: str, where: str = "", params: tuple[object, ...] = ()) -> int:
    with sqlite3.connect(db_path) as conn:
        query = f"SELECT COUNT(*) FROM {table} {where}"
        return int(conn.execute(query, params).fetchone()[0])


def table_counts(db_path: Path, tables: tuple[str, ...]) -> dict[str, int]:
    return {table: fetch_count(db_path, table) for table in tables}


def runtime_payload(room: JsonObject, *, tick: int = 12345, shard: str = "shardX") -> JsonObject:
    return {
        "type": "runtime-summary",
        "tick": tick,
        "shard": shard,
        "cpu": {"bucket": 9000, "used": 7.5},
        "reliability": {"loopExceptionCount": 0, "telemetrySilenceTicks": 0},
        "rooms": [room],
    }


class ScreepsRlMetricsIngestorTest(unittest.TestCase):
    def test_schema_initialization_creates_required_tables_and_definitions(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = Path(temp_dir) / "rl_metrics.sqlite"

            result = ingestor.initialize_database(db_path)

            self.assertGreaterEqual(result["metric_definitions"], 20)
            with sqlite3.connect(db_path) as conn:
                tables = {
                    row[0]
                    for row in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                }
                metric_observation_columns = {
                    row[1] for row in conn.execute("PRAGMA table_info(metric_observations)").fetchall()
                }
                runtime_room_metric_columns = {
                    row[1] for row in conn.execute("PRAGMA table_info(runtime_room_metrics)").fetchall()
                }
                dedupe_indexes = {
                    table: {
                        row[1]
                        for row in conn.execute(f"PRAGMA index_list({table})").fetchall()
                        if row[2]
                    }
                    for table in ingestor.DEDUPE_TABLE_KEYS
                }

        self.assertIn("metric_definitions", tables)
        self.assertIn("metric_observations", tables)
        self.assertIn("runtime_room_metrics", tables)
        self.assertIn("gameplay_behavior_findings", tables)
        self.assertIn("metric_coverage_gaps", tables)
        self.assertIn("rl_dataset_gate_metrics", tables)
        self.assertIn("rl_training_execution_metrics", tables)
        self.assertIn("rl_policy_advantage_metrics", tables)
        self.assertIn("metric_iteration_decisions", tables)

        self.assertIn("dedupe_key", metric_observation_columns)
        for column_name in (
            "pending_build_progress",
            "build_carried_energy",
            "build_blocked_reason",
            "construction_site_count",
            "construction_deadlock_ticks",
            "extension_count",
            "extension_capacity_contribution",
            "path_finding_failures",
            "destination_blocked",
            "worker_load_trip_energy_mean",
            "worker_load_trip_energy_min",
            "cpu_used",
            "cpu_bucket",
            "rcl_level",
            "stored_energy",
            "controller_progress_ratio",
            "upgrade_carried_energy",
            "import_demand",
            "blocked_import_energy",
            "multi_room_deficit_energy",
        ):
            self.assertIn(column_name, runtime_room_metric_columns)
        for table in ingestor.DEDUPE_TABLE_KEYS:
            self.assertIn(f"idx_{table}_dedupe_key", dedupe_indexes[table])

    def test_reingesting_nullable_key_runtime_artifact_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            db_path = root / "rl_metrics.sqlite"
            artifact_root = write_runtime_artifact(
                root,
                {
                    "type": "runtime-summary",
                    "shard": "shardX",
                    "cpu": {"bucket": 9000, "used": 7.5},
                    "rooms": [
                        {
                            "roomName": "E26S49",
                            "controller": {"my": True, "level": 2},
                            "workerCount": 2,
                            "spawnStatus": [{"name": "Spawn1", "status": "idle"}],
                            "taskCounts": {"harvest": 1},
                            "behavior": {
                                "lowLoadReturnCount": 1,
                                "lastReturnEnergy": 2,
                                "returnCapacity": 50,
                            },
                        }
                    ],
                },
            )
            tables = (
                "metric_observations",
                "gameplay_behavior_findings",
                "metric_coverage_gaps",
            )

            ingestor.ingest_artifacts(db_path, [artifact_root])
            first_counts = table_counts(db_path, tables)
            ingestor.ingest_artifacts(db_path, [artifact_root])

            self.assertEqual(table_counts(db_path, tables), first_counts)
            self.assertEqual(
                fetch_count(
                    db_path,
                    "metric_observations",
                    "WHERE metric_name = ? AND tick IS NULL AND room_name IS NULL",
                    ("survival.owned_rooms",),
                ),
                1,
            )
            self.assertEqual(
                fetch_count(
                    db_path,
                    "gameplay_behavior_findings",
                    "WHERE category = ? AND tick IS NULL",
                    ("low-load-return",),
                ),
                1,
            )
            self.assertEqual(
                fetch_count(
                    db_path,
                    "metric_coverage_gaps",
                    "WHERE metric_name = ? AND gap_type = ? AND tick IS NULL",
                    ("economy.energy_telemetry", "missing_energy_fields"),
                ),
                1,
            )

    def test_ingests_runtime_summary_and_finds_build_zero_with_backlog(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            db_path = root / "rl_metrics.sqlite"
            artifact_root = write_runtime_artifact(
                root,
                runtime_payload(
                    {
                        "roomName": "E26S49",
                        "controller": {"my": True, "level": 3, "progress": 3000, "progressTotal": 15000},
                        "rclLevel": 3,
                        "workerCount": 4,
                        "spawnStatus": [{"name": "Spawn1", "status": "idle"}],
                        "taskCounts": {"harvest": 1, "upgrade": 3, "build": 0},
                        "energyAvailable": 300,
                        "pendingBuildProgress": 700,
                        "buildCarriedEnergy": 0,
                        "buildBlockedReason": "worker_assignment_gap",
                        "constructionSiteCount": 2,
                        "constructionDeadlockTicks": 125,
                        "extensionCount": 0,
                        "extensionCapacityContribution": 0,
                        "behavior": {
                            "totals": {
                                "stuckTicks": 2,
                                "pathFindingFailures": 2,
                                "destinationBlocked": 1,
                            }
                        },
                        "workerLoadEfficiency": {
                            "sampleCount": 2,
                            "tripEnergyMean": 7,
                            "tripEnergyMin": 5,
                        },
                        "cpuUsed": 6.25,
                        "cpuBucket": 8123,
                        "storedEnergy": 800,
                        "resources": {
                            "storedEnergy": 800,
                            "workerCarriedEnergy": 120,
                            "multiRoomEnergy": {
                                "importDemand": 250,
                                "blockedImportEnergy": 90,
                                "deficitEnergy": 350,
                            },
                            "productiveEnergy": {
                                "pendingBuildProgress": 700,
                                "builtProgress": 0,
                                "buildCarriedEnergy": 0,
                                "upgradeCarriedEnergy": 45,
                                "buildBlockedReason": "worker_assignment_gap",
                            },
                        },
                        "constructionPriority": {
                            "nextPrimary": {
                                "buildItem": "build tower",
                                "urgency": "high",
                            }
                        },
                        "combat": {"hostileCreepCount": 0},
                        "structures": {"spawn": 1, "tower": 0, "rampart": 0},
                    }
                ),
            )

            stats = ingestor.ingest_artifacts(db_path, [artifact_root])

            self.assertEqual(stats["runtime_summaries"], 1)
            self.assertEqual(
                fetch_count(
                    db_path,
                    "metric_observations",
                    "WHERE metric_name = ?",
                    ("construction.backlog_progress",),
                ),
                1,
            )
            with sqlite3.connect(db_path) as conn:
                row = conn.execute(
                    """
                    SELECT pending_build_progress, build_carried_energy, construction_site_count,
                           construction_deadlock_ticks, build_blocked_reason, extension_count, extension_capacity_contribution,
                           path_finding_failures, destination_blocked,
                           worker_load_trip_energy_mean, worker_load_trip_energy_min,
                           cpu_used, cpu_bucket, rcl_level, stored_energy,
                           controller_progress_ratio, upgrade_carried_energy, import_demand,
                           blocked_import_energy, multi_room_deficit_energy
                    FROM runtime_room_metrics
                    WHERE room_name = ?
                    """,
                    ("E26S49",),
                ).fetchone()
            summary = json.loads(ingestor.summarize_database(db_path, output_format="json"))

            self.assertEqual(
                row,
                (
                    700.0,
                    0.0,
                    2.0,
                    125.0,
                    "worker_assignment_gap",
                    0.0,
                    0.0,
                    2.0,
                    1.0,
                    7.0,
                    5.0,
                    6.25,
                    8123.0,
                    3.0,
                    800.0,
                    0.2,
                    45.0,
                    250.0,
                    90.0,
                    350.0,
                ),
            )
            self.assertEqual(summary["latestRuntimeRoomMetrics"]["pendingBuildProgress"], 700.0)
            self.assertEqual(summary["latestRuntimeRoomMetrics"]["constructionSiteCount"], 2.0)
            self.assertEqual(summary["latestRuntimeRoomMetrics"]["constructionDeadlockTicks"], 125.0)
            self.assertEqual(summary["latestRuntimeRoomMetrics"]["pathFindingFailures"], 2.0)
            self.assertEqual(summary["latestRuntimeRoomMetrics"]["workerLoadTripEnergyMin"], 5.0)
            self.assertEqual(summary["latestRuntimeRoomMetrics"]["minCpuBucket"], 8123.0)
            self.assertEqual(summary["latestRuntimeRoomMetrics"]["avgControllerProgressRatio"], 0.2)
            self.assertEqual(summary["latestRuntimeRoomMetrics"]["upgradeCarriedEnergy"], 45.0)
            self.assertEqual(summary["latestRuntimeRoomMetrics"]["importDemand"], 250.0)
            self.assertEqual(summary["latestRuntimeRoomMetrics"]["blockedImportEnergy"], 90.0)
            self.assertEqual(summary["latestRuntimeRoomMetrics"]["multiRoomDeficitEnergy"], 350.0)
            self.assertEqual(
                fetch_count(
                    db_path,
                    "metric_observations",
                    "WHERE metric_name = ?",
                    ("construction.site_count",),
                ),
                1,
            )
            self.assertEqual(
                fetch_count(
                    db_path,
                    "metric_observations",
                    "WHERE metric_name = ?",
                    ("construction.deadlock_ticks",),
                ),
                1,
            )
            self.assertEqual(
                fetch_count(
                    db_path,
                    "metric_observations",
                    "WHERE metric_name = ? AND value_text = ?",
                    ("construction.build_blocked_reason", "worker_assignment_gap"),
                ),
                1,
            )
            self.assertEqual(
                fetch_count(
                    db_path,
                    "metric_observations",
                    "WHERE metric_name = ?",
                    ("creep.path_finding_failures",),
                ),
                1,
            )
            self.assertEqual(
                fetch_count(
                    db_path,
                    "metric_observations",
                    "WHERE metric_name = ?",
                    ("creep.worker_load_trip_energy_min",),
                ),
                1,
            )
            for metric_name in (
                "territory.controller_progress_ratio",
                "controller.upgrade_carried_energy",
                "economy.import_demand",
                "economy.blocked_import_energy",
                "economy.multi_room_deficit_energy",
            ):
                self.assertEqual(
                    fetch_count(db_path, "metric_observations", "WHERE metric_name = ?", (metric_name,)),
                    1,
                )
            self.assertEqual(
                fetch_count(
                    db_path,
                    "gameplay_behavior_findings",
                    "WHERE category = ? AND severity = ?",
                    ("stalled-construction", "critical"),
                ),
                1,
            )

    def test_runtime_room_summary_keeps_partial_energy_aggregate_unknown(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            db_path = root / "rl_metrics.sqlite"
            payload = {
                "type": "runtime-summary",
                "tick": 12345,
                "shard": "shardX",
                "cpu": {"bucket": 9000, "used": 7.5},
                "reliability": {"loopExceptionCount": 0, "telemetrySilenceTicks": 0},
                "rooms": [
                    {
                        "roomName": "E26S49",
                        "controller": {"my": True, "level": 3, "progress": 3000, "progressTotal": 15000},
                        "resources": {
                            "productiveEnergy": {"upgradeCarriedEnergy": 45},
                            "multiRoomEnergy": {
                                "importDemand": 250,
                                "blockedImportEnergy": 90,
                                "deficitEnergy": 350,
                            },
                        },
                    },
                    {
                        "roomName": "E26S50",
                        "controller": {"my": True, "level": 3, "progress": 6000, "progressTotal": 15000},
                    },
                ],
            }
            artifact_root = write_runtime_artifact(root, payload)

            ingestor.ingest_artifacts(db_path, [artifact_root])
            summary = json.loads(ingestor.summarize_database(db_path, output_format="json"))
            metrics = summary["latestRuntimeRoomMetrics"]

            self.assertEqual(metrics["roomSamples"], 2)
            self.assertAlmostEqual(metrics["avgControllerProgressRatio"], 0.3)
            self.assertIsNone(metrics["upgradeCarriedEnergy"])
            self.assertIsNone(metrics["importDemand"])
            self.assertIsNone(metrics["blockedImportEnergy"])
            self.assertIsNone(metrics["multiRoomDeficitEnergy"])

    def test_missing_energy_fields_record_coverage_gap_instead_of_crashing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            db_path = root / "rl_metrics.sqlite"
            artifact_root = write_runtime_artifact(
                root,
                runtime_payload(
                    {
                        "roomName": "E26S49",
                        "controller": {"my": True, "level": 2},
                        "workerCount": 1,
                        "spawnStatus": [{"name": "Spawn1", "status": "idle"}],
                        "taskCounts": {"harvest": 1},
                    }
                ),
            )

            ingestor.ingest_artifacts(db_path, [artifact_root])

            self.assertEqual(
                fetch_count(
                    db_path,
                    "metric_coverage_gaps",
                    "WHERE metric_name = ? AND gap_type = ?",
                    ("economy.energy_telemetry", "missing_energy_fields"),
                ),
                1,
            )

    def test_runtime_room_metric_dedupe_keeps_same_tick_room_across_shards(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            db_path = root / "rl_metrics.sqlite"
            artifact_dir = root / "runtime-summary-console"
            artifact_dir.mkdir(parents=True, exist_ok=True)
            room = {
                "roomName": "E26S49",
                "controller": {"my": True, "level": 3},
                "pendingBuildProgress": 700,
            }
            (artifact_dir / "runtime.log").write_text(
                runtime_line(runtime_payload(room, tick=12345, shard="shardX"))
                + runtime_line(runtime_payload(room, tick=12345, shard="shardY")),
                encoding="utf-8",
            )

            ingestor.ingest_artifacts(db_path, [artifact_dir])

            with sqlite3.connect(db_path) as conn:
                rows = conn.execute(
                    """
                    SELECT shard, room_name, tick, pending_build_progress
                    FROM runtime_room_metrics
                    ORDER BY shard
                    """
                ).fetchall()

            self.assertEqual(
                rows,
                [
                    ("shardX", "E26S49", 12345, 700.0),
                    ("shardY", "E26S49", 12345, 700.0),
                ],
            )

    def test_training_report_component_order_maps_reward_and_policy_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            db_path = root / "rl_metrics.sqlite"
            artifact_dir = root / "rl-training"
            artifact_dir.mkdir(parents=True, exist_ok=True)
            component_order = ["reliability", "territory", "resources", "kills"]
            report = {
                "type": "screeps-rl-training-report",
                "reportId": "component-order-report",
                "rewardModel": {"componentOrder": component_order},
                "incumbentStrategyIds": ["baseline"],
                "variantResults": [
                    {
                        "variantId": "baseline",
                        "sampleCount": 1,
                        "reward": {"tuple": [1, 5, 50, 0], "componentOrder": component_order},
                    },
                    {
                        "variantId": "candidate",
                        "sampleCount": 1,
                        "reward": {"tuple": [1, 7, 60, 3], "componentOrder": component_order},
                    },
                ],
                "ranking": [
                    {"variantId": "candidate", "rewardTuple": [1, 7, 60, 3]},
                    {"variantId": "baseline", "rewardTuple": [1, 5, 50, 0]},
                ],
            }
            (artifact_dir / "training-report.json").write_text(json.dumps(report), encoding="utf-8")

            stats = ingestor.ingest_artifacts(db_path, [artifact_dir])

            with sqlite3.connect(db_path) as conn:
                reward_rows = {
                    row[0]: row[1]
                    for row in conn.execute(
                        """
                        SELECT metric_name, value
                        FROM rl_training_execution_metrics
                        WHERE report_id = ? AND variant_id = ? AND metric_name LIKE 'rl.training.reward_%'
                        """,
                        ("component-order-report", "candidate"),
                    ).fetchall()
                }
                advantage_rows = {
                    row[0]: row[1]
                    for row in conn.execute(
                        """
                        SELECT metric_name, value
                        FROM rl_policy_advantage_metrics
                        WHERE report_id = ? AND candidate_id = ? AND incumbent_id = ?
                        """,
                        ("component-order-report", "candidate", "baseline"),
                    ).fetchall()
                }

            self.assertEqual(stats["training_artifacts"], 1)
            self.assertEqual(
                reward_rows,
                {
                    "rl.training.reward_territory": 7.0,
                    "rl.training.reward_resources": 60.0,
                    "rl.training.reward_kills": 3.0,
                },
            )
            self.assertEqual(
                advantage_rows,
                {
                    "rl.policy.advantage_territory": 2.0,
                    "rl.policy.advantage_resources": 10.0,
                    "rl.policy.advantage_kills": 3.0,
                },
            )

    def test_training_report_component_order_mismatch_suppresses_component_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            db_path = root / "rl_metrics.sqlite"
            artifact_dir = root / "rl-training"
            artifact_dir.mkdir(parents=True, exist_ok=True)
            component_order = ["reliability", "territory", "resources", "kills"]
            report = {
                "type": "screeps-rl-training-report",
                "reportId": "component-order-mismatch-report",
                "rewardModel": {"componentOrder": component_order},
                "incumbentStrategyIds": ["baseline"],
                "variantResults": [
                    {
                        "variantId": "baseline",
                        "sampleCount": 1,
                        "reward": {"tuple": [5, 50, 0], "componentOrder": component_order},
                    },
                    {
                        "variantId": "candidate",
                        "sampleCount": 1,
                        "reward": {"tuple": [7, 60, 3], "componentOrder": component_order},
                    },
                ],
                "ranking": [
                    {"variantId": "candidate", "rewardTuple": [7, 60, 3]},
                    {"variantId": "baseline", "rewardTuple": [5, 50, 0]},
                ],
            }
            (artifact_dir / "training-report.json").write_text(json.dumps(report), encoding="utf-8")

            stats = ingestor.ingest_artifacts(db_path, [artifact_dir])

            with sqlite3.connect(db_path) as conn:
                reward_rows = conn.execute(
                    """
                    SELECT metric_name, value
                    FROM rl_training_execution_metrics
                    WHERE report_id = ? AND metric_name LIKE 'rl.training.reward_%'
                    """,
                    ("component-order-mismatch-report",),
                ).fetchall()
                advantage_rows = conn.execute(
                    """
                    SELECT metric_name, value
                    FROM rl_policy_advantage_metrics
                    WHERE report_id = ?
                    """,
                    ("component-order-mismatch-report",),
                ).fetchall()

            self.assertEqual(stats["training_artifacts"], 1)
            self.assertEqual(reward_rows, [])
            self.assertEqual(advantage_rows, [])

    def test_low_load_return_metric_creates_behavior_finding(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            db_path = root / "rl_metrics.sqlite"
            artifact_root = write_runtime_artifact(
                root,
                runtime_payload(
                    {
                        "roomName": "E26S49",
                        "controller": {"my": True, "level": 2},
                        "workerCount": 2,
                        "spawnStatus": [{"name": "Spawn1", "status": "idle"}],
                        "taskCounts": {"harvest": 1, "transfer": 1},
                        "energyAvailable": 250,
                        "resources": {"storedEnergy": 400, "workerCarriedEnergy": 2},
                        "behavior": {
                            "lowLoadReturnCount": 1,
                            "lastReturnEnergy": 2,
                            "returnCapacity": 50,
                        },
                    }
                ),
            )

            ingestor.ingest_artifacts(db_path, [artifact_root])

            self.assertEqual(
                fetch_count(
                    db_path,
                    "metric_observations",
                    "WHERE metric_name = ?",
                    ("creep.low_load_return_count",),
                ),
                1,
            )
            self.assertEqual(
                fetch_count(
                    db_path,
                    "gameplay_behavior_findings",
                    "WHERE category = ?",
                    ("low-load-return",),
                ),
                1,
            )


if __name__ == "__main__":
    unittest.main()
