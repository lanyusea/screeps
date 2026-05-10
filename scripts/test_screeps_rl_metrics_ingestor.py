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


def runtime_payload(room: JsonObject) -> JsonObject:
    return {
        "type": "runtime-summary",
        "tick": 12345,
        "shard": "shardX",
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
        self.assertIn("gameplay_behavior_findings", tables)
        self.assertIn("metric_coverage_gaps", tables)
        self.assertIn("rl_dataset_gate_metrics", tables)
        self.assertIn("rl_training_execution_metrics", tables)
        self.assertIn("rl_policy_advantage_metrics", tables)
        self.assertIn("metric_iteration_decisions", tables)

        self.assertIn("dedupe_key", metric_observation_columns)
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
                        "controller": {"my": True, "level": 3},
                        "workerCount": 4,
                        "spawnStatus": [{"name": "Spawn1", "status": "idle"}],
                        "taskCounts": {"harvest": 1, "upgrade": 3, "build": 0},
                        "energyAvailable": 300,
                        "resources": {
                            "storedEnergy": 800,
                            "workerCarriedEnergy": 120,
                            "productiveEnergy": {
                                "pendingBuildProgress": 700,
                                "builtProgress": 0,
                                "buildCarriedEnergy": 0,
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
            self.assertEqual(
                fetch_count(
                    db_path,
                    "gameplay_behavior_findings",
                    "WHERE category = ? AND severity = ?",
                    ("stalled-construction", "critical"),
                ),
                1,
            )

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
