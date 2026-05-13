#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch


def load_roadmap_module() -> Any:
    module_path = Path(__file__).with_name("generate-roadmap-page.py")
    spec = importlib.util.spec_from_file_location("generate_roadmap_page", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load generate-roadmap-page.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


roadmap = load_roadmap_module()
GENERATED_AT = "2026-05-05T00:00:00Z"
DELIVERY_WINDOW_GENERATED_AT = "2026-05-12T00:00:00Z"


def deploy_evidence(
    *,
    ok: bool = True,
    mode: str = "deploy",
    timestamp: str = "2026-04-28T00:00:00Z",
    commit: str = "a" * 40,
    run_id: int | str | None = None,
    branch_code: dict[str, Any] | None = None,
    active_world: dict[str, Any] | None = None,
) -> dict[str, Any]:
    evidence: dict[str, Any] = {
        "ok": ok,
        "mode": mode,
        "timestampUtc": timestamp,
        "git": {"commit": commit},
        "target": {"branch": "main"},
        "verification": {
            "branchCode": branch_code or {"status": "matched", "matched": True},
            "activeWorld": active_world or {"status": "matched", "activeWorldBranch": "main"},
        },
    }
    if run_id is not None:
        evidence["runId"] = run_id
    return evidence


def write_evidence(repo_root: Path, name: str, evidence: dict[str, Any] | str) -> None:
    path = repo_root / "runtime-artifacts" / "official-screeps-deploy" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(evidence, str):
        path.write_text(evidence, encoding="utf-8")
    else:
        path.write_text(json.dumps(evidence), encoding="utf-8")


def private_smoke_report(
    *,
    ok: bool = True,
    dry_run: bool = False,
    started_at: str = "2026-05-10T00:00:00Z",
    finished_at: str = "2026-05-10T00:10:00Z",
    report_path: str = "",
) -> dict[str, Any]:
    report: dict[str, Any] = {
        "ok": ok,
        "dry_run": dry_run,
        "started_at": started_at,
        "finished_at": finished_at,
        "smoke": {
            "room": "E1S1",
            "shard": "shardX",
            "spawn": {"name": "Spawn1"},
            "username": "smoke",
        },
    }
    if report_path:
        report["report_path"] = report_path
    return report


def write_private_smoke_report(repo_root: Path, relative: str, report: dict[str, Any] | str) -> None:
    path = repo_root / "runtime-artifacts" / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(report, str):
        path.write_text(report, encoding="utf-8")
    else:
        report.setdefault("report_path", str(path))
        path.write_text(json.dumps(report), encoding="utf-8")


def write_codex_session(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n", encoding="utf-8")


def utc_text(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def insert_metric_point(
    conn: sqlite3.Connection,
    *,
    sampled_at: str,
    metric: str = "owned_rooms",
    value: int | float | None = 1,
    status: str = "observed",
    instrumented: bool = True,
    observed: bool = True,
) -> None:
    spec = next(item for item in roadmap.METRIC_SPECS if item.key == metric)
    conn.execute(
        """
        INSERT INTO metric_points
        (captured_at, metric, category, label, value, unit, layer, instrumented, observed, status, source, details_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            sampled_at,
            spec.key,
            spec.category,
            spec.label,
            value,
            spec.unit,
            spec.layer,
            int(instrumented),
            int(observed),
            status,
            spec.source,
            "{}",
        ),
    )


def metric_history_point(sampled_at: str, value: int | float = 1) -> dict[str, Any]:
    return {
        "sampledAt": sampled_at,
        "value": value,
        "instrumented": True,
        "observed": True,
        "status": "observed",
    }


def lfs_pointer_text() -> str:
    return (
        "\n".join(
            [
                "version https://git-lfs.github.com/spec/v1",
                "oid sha256:" + ("a" * 64),
                "size 69632",
            ]
        )
        + "\n"
    )


def runtime_summary_line(*, tick: int, level: int = 3, stored_energy: int = 0, hostile_creeps: int = 0) -> str:
    payload = {
        "type": "runtime-summary",
        "tick": tick,
        "source": "test",
        "rooms": [
            {
                "roomName": "E19S57",
                "shard": "shardX",
                "controller": {
                    "level": level,
                    "progress": tick,
                    "progressTotal": 100000,
                    "ticksToDowngrade": 10000,
                },
                "resources": {
                    "storedEnergy": stored_energy,
                    "workerCarriedEnergy": 10,
                    "droppedEnergy": 0,
                    "sourceCount": 2,
                },
                "combat": {
                    "hostileCreepCount": hostile_creeps,
                    "hostileStructureCount": 0,
                },
            }
        ],
    }
    return f"#runtime-summary {json.dumps(payload, sort_keys=True)}\n"


def token_count_record(timestamp: str, total_tokens: int) -> dict[str, Any]:
    return {
        "timestamp": timestamp,
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "info": {"total_token_usage": {"total_tokens": total_tokens}},
        },
    }


def session_meta_record(timestamp: str, cwd: Path | str) -> dict[str, Any]:
    return {
        "timestamp": timestamp,
        "type": "session_meta",
        "payload": {"cwd": str(cwd), "originator": "codex_exec"},
    }


class GenerateRoadmapPageTest(unittest.TestCase):
    def test_screeps_room_target_falls_back_to_current_official_room(self) -> None:
        target = roadmap.build_screeps_room_target({})

        self.assertEqual(target["status"], "official target")
        self.assertEqual(target["label"], "shardX/E19S57")
        self.assertEqual(target["shard"], "shardX")
        self.assertEqual(target["room"], "E19S57")
        self.assertEqual(target["url"], "https://screeps.com/a/#!/room/shardX/E19S57")

    def test_load_metric_history_keeps_latest_seven_cst_days_for_hourly_samples(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.execute("PRAGMA foreign_keys=ON")
        roadmap.ensure_schema(conn)
        roadmap.write_metric_definitions(conn)
        start = datetime(2026, 4, 29, 0, 0, tzinfo=timezone.utc)
        for hour in range(8 * 24):
            sampled_at = utc_text(start + timedelta(hours=hour))
            insert_metric_point(conn, sampled_at=sampled_at, value=hour)
        conn.commit()

        history = roadmap.load_metric_history(conn)
        points = history["owned_rooms"]
        buckets = roadmap.report_kpi_date_buckets(history, "2026-05-06T23:30:00Z")
        values, statuses = roadmap.metric_history_values(history, "owned_rooms", buckets)

        self.assertGreater(len(points), 24)
        self.assertEqual([roadmap.format_report_date(bucket) for bucket in buckets], ["5/1", "5/2", "5/3", "5/4", "5/5", "5/6", "5/7"])
        self.assertEqual(statuses, ["observed"] * 7)
        self.assertEqual(len([value for value in values if value is not None]), 7)

    def test_report_kpi_missing_middle_days_stay_blank_and_collecting(self) -> None:
        history = {
            "owned_rooms": [
                metric_history_point("2026-05-01T12:00:00Z", 1),
                metric_history_point("2026-05-05T12:00:00Z", 2),
            ],
            "controller_level_sum": [
                metric_history_point("2026-05-01T12:00:00Z", 2),
                metric_history_point("2026-05-05T12:00:00Z", 3),
            ],
        }

        cards = roadmap.build_report_kpi_cards(history, "2026-05-05T15:00:00Z")
        territory = next(card for card in cards if card["key"] == "territory")
        owned_rooms = next(series for series in territory["series"] if series["label"] == "Owned rooms")

        self.assertEqual(territory["dates"], ["4/29", "4/30", "5/1", "5/2", "5/3", "5/4", "5/5"])
        self.assertEqual(owned_rooms["values"], [None, None, 1, None, None, None, 2])
        self.assertEqual(owned_rooms["statuses"], ["missing", "missing", "observed", "missing", "missing", "missing", "observed"])
        self.assertEqual(territory["history"]["status"], "collecting")
        self.assertEqual(territory["history"]["observedDays"], 2)
        self.assertTrue(territory["history"]["insufficient"])
        self.assertIn("History collecting (2/7 days observed; insufficient for a complete 7d trend)", territory["footer"])

    def test_lfs_pointer_history_db_reports_cold_start_collecting_status(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "docs" / "roadmap-kpi.sqlite"
            db_path.parent.mkdir(parents=True, exist_ok=True)
            db_path.write_text(lfs_pointer_text(), encoding="utf-8")

            conn, db_status = roadmap.prepare_history_db(db_path)
            try:
                roadmap.write_metric_definitions(conn)
                insert_metric_point(conn, sampled_at="2026-05-05T12:00:00Z", value=1)
                conn.commit()
                history = roadmap.load_metric_history(conn)
            finally:
                conn.close()

        source = roadmap.summarize_kpi_history_source(db_status, {"status": "unavailable", "dailyBucketDays": 0})
        cards = roadmap.build_report_kpi_cards(history, "2026-05-05T15:00:00Z", source)
        territory = next(card for card in cards if card["key"] == "territory")

        self.assertEqual(db_status["status"], "cold-start-lfs-pointer")
        self.assertTrue(db_status["coldStart"])
        self.assertEqual(territory["history"]["status"], "collecting")
        self.assertTrue(territory["history"]["insufficient"])
        self.assertIn("SQLite history is cold-started", territory["footer"])

    def test_unexpected_lfs_pointer_history_db_path_is_not_deleted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "nested" / "docs" / "roadmap-kpi.sqlite"
            db_path.parent.mkdir(parents=True, exist_ok=True)
            original = lfs_pointer_text()
            db_path.write_text(original, encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "Refusing to auto-recreate KPI history DB"):
                roadmap.prepare_history_db(db_path)

            self.assertEqual(db_path.read_text(encoding="utf-8"), original)

    def test_unexpected_invalid_history_db_path_is_not_deleted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "docs" / "unexpected.sqlite"
            db_path.parent.mkdir(parents=True, exist_ok=True)
            original = "not a sqlite database\n"
            db_path.write_text(original, encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "only docs/roadmap-kpi.sqlite"):
                roadmap.prepare_history_db(db_path)

            self.assertEqual(db_path.read_text(encoding="utf-8"), original)

    def test_symlink_history_db_recovery_path_is_not_deleted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "target-lfs-pointer"
            target.write_text(lfs_pointer_text(), encoding="utf-8")
            db_path = Path(tmp) / "docs" / "roadmap-kpi.sqlite"
            db_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                db_path.symlink_to(target)
            except (NotImplementedError, OSError) as error:
                self.skipTest(f"symlink creation unavailable: {error}")

            with self.assertRaisesRegex(RuntimeError, "symlink component"):
                roadmap.prepare_history_db(db_path)

            self.assertTrue(db_path.is_symlink())
            self.assertEqual(target.read_text(encoding="utf-8"), lfs_pointer_text())

    def test_runtime_artifact_history_derives_daily_buckets_outside_sqlite(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            artifact_dir = repo_root / "runtime-artifacts" / "runtime-summary-console"
            artifact_dir.mkdir(parents=True)
            for day_offset in range(7):
                timestamp = datetime(2026, 5, 1 + day_offset, 12, 0, tzinfo=timezone.utc)
                path = artifact_dir / f"runtime-summary-console-{timestamp.strftime('%Y%m%dT%H%M%SZ')}.log"
                path.write_text(
                    runtime_summary_line(tick=1000 + day_offset, level=2 + day_offset, stored_energy=day_offset * 10),
                    encoding="utf-8",
                )

            artifact_history, artifact_status = roadmap.load_runtime_artifact_metric_history(
                repo_root,
                "2026-05-07T15:00:00Z",
                {},
                paths=[str(repo_root / "runtime-artifacts")],
            )

        cards = roadmap.build_report_kpi_cards(
            artifact_history,
            "2026-05-07T15:00:00Z",
            roadmap.summarize_kpi_history_source({"status": "created"}, artifact_status),
        )
        territory = next(card for card in cards if card["key"] == "territory")
        owned_rooms = next(series for series in territory["series"] if series["label"] == "Owned rooms")

        self.assertEqual(artifact_status["dailyBucketDays"], 7)
        self.assertEqual(owned_rooms["values"], [1, 1, 1, 1, 1, 1, 1])
        self.assertEqual(territory["history"]["status"], "complete")
        self.assertIn("reducer-backed KPI history", territory["footer"])

    def test_runtime_artifact_history_blanks_not_observed_resource_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            artifact_dir = repo_root / "runtime-artifacts" / "runtime-summary-console"
            artifact_dir.mkdir(parents=True)
            older = {
                "type": "runtime-summary",
                "tick": 100,
                "rooms": [
                    {
                        "roomName": "E19S57",
                        "shard": "shardX",
                        "resources": {
                            "storedEnergy": 50,
                            "workerCarriedEnergy": 5,
                            "droppedEnergy": 0,
                            "sourceCount": 2,
                        },
                    }
                ],
            }
            newer = {
                "type": "runtime-summary",
                "tick": 120,
                "rooms": [{"roomName": "E19S57", "shard": "shardX"}],
            }
            (artifact_dir / "runtime-summary-console-20260501T120000Z.log").write_text(
                f"#runtime-summary {json.dumps(older, sort_keys=True)}\n",
                encoding="utf-8",
            )
            (artifact_dir / "runtime-summary-console-20260501T130000Z.log").write_text(
                f"#runtime-summary {json.dumps(newer, sort_keys=True)}\n",
                encoding="utf-8",
            )

            artifact_history, artifact_status = roadmap.load_runtime_artifact_metric_history(
                repo_root,
                "2026-05-01T15:00:00Z",
                {},
                paths=[str(repo_root / "runtime-artifacts")],
            )

        stored_energy = artifact_history["stored_energy"][0]
        self.assertEqual(artifact_status["dailyBucketDays"], 1)
        self.assertIsNone(stored_energy["value"])
        self.assertFalse(stored_energy["observed"])
        self.assertEqual(stored_energy["status"], "not observed")

        cards = roadmap.build_report_kpi_cards(artifact_history, "2026-05-01T15:00:00Z")
        resources = next(card for card in cards if card["key"] == "resources")
        stored_series = next(series for series in resources["series"] if series["label"] == "Stored energy")

        self.assertIsNone(stored_series["values"][-1])
        self.assertEqual(stored_series["statuses"][-1], "not observed")

    def test_not_observed_sections_still_emit_valid_delta_and_event_metrics(self) -> None:
        report = {
            "territory": {
                "ownedRooms": {
                    "status": "observed",
                    "latest": [],
                    "latestCount": 0,
                    "deltaCount": -1,
                    "gained": [],
                    "lost": ["E19S57"],
                },
                "controllers": {"status": "not instrumented"},
            },
            "resources": {
                "status": "not observed",
                "totals": {
                    "latest": {"storedEnergy": None},
                    "delta": {"storedEnergy": -100},
                },
                "eventDeltas": {
                    "status": "observed",
                    "harvestedEnergy": 6,
                    "transferredEnergy": 4,
                },
            },
            "combat": {
                "status": "not observed",
                "totals": {
                    "latest": {
                        "hostileCreepCount": None,
                        "hostileStructureCount": None,
                    },
                    "delta": {
                        "hostileCreepCount": -3,
                        "hostileStructureCount": -1,
                    },
                },
                "eventDeltas": {
                    "status": "observed",
                    "attackCount": 2,
                    "attackDamage": 9,
                    "objectDestroyedCount": 1,
                    "creepDestroyedCount": 0,
                },
            },
            "source": {"matchedFiles": 1, "runtimeSummaryLines": 2},
            "input": {"runtimeSummaryCount": 2},
        }

        metrics = {metric["key"]: metric for metric in roadmap.build_current_metrics(report)}

        self.assertEqual(metrics["stored_energy"]["status"], "not observed")
        self.assertIsNone(metrics["stored_energy"]["value"])
        self.assertEqual(metrics["stored_energy_delta"]["status"], "observed")
        self.assertEqual(metrics["stored_energy_delta"]["value"], -100)
        self.assertEqual(metrics["harvested_energy"]["status"], "observed")
        self.assertEqual(metrics["harvested_energy"]["value"], 6)
        self.assertEqual(metrics["hostile_creeps"]["status"], "not observed")
        self.assertIsNone(metrics["hostile_creeps"]["value"])
        self.assertEqual(metrics["attack_damage"]["status"], "observed")
        self.assertEqual(metrics["attack_damage"]["value"], 9)

    def test_mixed_room_artifacts_keep_observed_values_and_carry_scope(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            artifact_dir = repo_root / "runtime-artifacts" / "runtime-summary-console"
            artifact_dir.mkdir(parents=True)
            payload = {
                "type": "runtime-summary",
                "tick": 100,
                "rooms": [
                    {
                        "roomName": "E19S57",
                        "shard": "shardX",
                        "resources": {
                            "storedEnergy": 75,
                            "workerCarriedEnergy": 5,
                            "droppedEnergy": 0,
                            "sourceCount": 2,
                        },
                    },
                    {"roomName": "W9N9", "shard": "shardX"},
                ],
            }
            (artifact_dir / "runtime-summary-console-20260501T120000Z.log").write_text(
                f"#runtime-summary {json.dumps(payload, sort_keys=True)}\n",
                encoding="utf-8",
            )

            artifact_history, _artifact_status = roadmap.load_runtime_artifact_metric_history(
                repo_root,
                "2026-05-01T15:00:00Z",
                {},
                paths=[str(repo_root / "runtime-artifacts")],
            )

        stored_energy = artifact_history["stored_energy"][0]
        self.assertEqual(stored_energy["value"], 75)
        self.assertTrue(stored_energy["observed"])
        self.assertEqual(stored_energy["status"], "observed")
        self.assertEqual(stored_energy["sourceKind"], "runtime-summary-artifact")
        self.assertEqual(stored_energy["reducerSchemaVersion"], roadmap.runtime_kpi_reducer.SCHEMA_VERSION)
        self.assertEqual(stored_energy["scope"]["targetShard"], "shardX")
        self.assertEqual(stored_energy["scope"]["targetRoom"], "E19S57")
        self.assertEqual(stored_energy["scope"]["observedRooms"], ["E19S57", "W9N9"])

    def test_counts_only_successful_official_deploy_evidence_json_in_delivery_window(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            write_evidence(
                repo_root,
                "official-screeps-deploy.json",
                deploy_evidence(
                    timestamp="2026-04-28T12:00:00Z",
                    commit="a" * 40,
                    active_world={"activeWorldBranch": "main", "code": {"status": "matched"}},
                ),
            )
            write_evidence(
                repo_root,
                "official-screeps-deploy-20260429.json",
                deploy_evidence(timestamp="2026-04-29T12:00:00Z", commit="b" * 40, run_id=8675309),
            )
            write_evidence(
                repo_root,
                "official-screeps-deploy-8675309/official-screeps-deploy.json",
                deploy_evidence(timestamp="2026-04-29T12:00:00Z", commit="b" * 40),
            )
            write_evidence(
                repo_root,
                "official-screeps-deploy-20260420.json",
                deploy_evidence(timestamp="2026-04-20T12:00:00Z", commit="c" * 40, run_id=1234),
            )
            write_evidence(repo_root, "official-screeps-deploy-dry-run.json", deploy_evidence(mode="dry-run"))
            write_evidence(repo_root, "official-screeps-deploy-failed.json", deploy_evidence(ok=False))
            write_evidence(
                repo_root,
                "official-screeps-deploy-partial.json",
                deploy_evidence(active_world={"status": "not-requested"}),
            )
            write_evidence(
                repo_root,
                "official-screeps-deploy-mismatch.json",
                deploy_evidence(branch_code={"status": "mismatch", "matched": False}),
            )
            write_evidence(
                repo_root,
                "official-screeps-deploy-contradictory.json",
                deploy_evidence(branch_code={"status": "matched", "matched": False}),
            )
            write_evidence(
                repo_root,
                "official-screeps-deploy-wrong-active.json",
                deploy_evidence(active_world={"status": "matched", "activeWorldBranch": "default"}),
            )
            write_evidence(repo_root, "official-screeps-deploy-invalid.json", "{")

            summary = roadmap.summarize_official_deploy_evidence(repo_root, GENERATED_AT)

        self.assertEqual(summary.count, 2)
        self.assertEqual(summary.candidate_count, 11)
        self.assertIsNotNone(summary.latest)
        self.assertEqual(summary.latest.commit, "b" * 40)
        self.assertEqual(summary.latest.run_id, "8675309")
        self.assertEqual(summary.evidence_ids, ("commit-time:" + "a" * 40 + ":2026-04-28T12:00:00Z", "run:8675309"))

    def test_report_process_card_uses_official_deploy_evidence_detail(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            write_evidence(
                repo_root,
                "official-screeps-deploy-20260429.json",
                deploy_evidence(timestamp="2026-04-29T12:00:00Z", commit="c" * 40, run_id="123456"),
            )

            with (
                patch.object(roadmap, "run_text", return_value="42\n"),
                patch.object(roadmap, "fetch_all_prs", return_value=([{"state": "MERGED"}], None)),
                patch.object(roadmap, "fetch_all_issues", return_value=([{"state": "OPEN"}], None)),
                patch.object(roadmap, "CODEX_SESSION_ROOT", repo_root / "missing-codex-sessions"),
                patch.object(roadmap, "HERMES_CRON_OUTPUT_ROOT", repo_root / "missing-cron-output"),
            ):
                cards = roadmap.build_report_process_cards(
                    repo_root,
                    {"fullName": "lanyusea/screeps"},
                    {},
                    {},
                    GENERATED_AT,
                )

        release_card = next(card for card in cards if card["label"] == "Deploys")
        self.assertEqual(release_card["value"], 1)
        self.assertEqual(release_card["source"], "accepted official deploy JSON")
        self.assertIn("latest commit cccccccccccc", release_card["detail"])
        self.assertIn("run 123456", release_card["detail"])
        self.assertEqual(release_card["provenance"]["window"]["days"], 7)
        self.assertEqual(release_card["provenance"]["countedIds"], ["run:123456"])

    def test_report_process_cards_do_not_count_project_prose_or_markdown_smoke_mentions(self) -> None:
        github_snapshot = {
            "projectItems": [
                {
                    "number": 1,
                    "title": "release item",
                    "evidence": "Official deploy run 111 succeeded.",
                },
                {
                    "number": 2,
                    "title": "duplicate release item",
                    "evidence": "Deployment floor satisfied by official deploy run 111.",
                },
            ],
            "issues": [],
        }
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            process_doc = repo_root / "docs" / "process" / "2026-05-10-private-smoke-note.md"
            process_doc.parent.mkdir(parents=True, exist_ok=True)
            process_doc.write_text("Mentioned private-smoke-report-20260510T010000Z.json without JSON evidence.\n", encoding="utf-8")

            with (
                patch.object(roadmap, "run_text", return_value="42\n"),
                patch.object(roadmap, "fetch_all_prs", return_value=([], None)),
                patch.object(roadmap, "fetch_all_issues", return_value=([], None)),
                patch.object(roadmap, "CODEX_SESSION_ROOT", repo_root / "missing-codex-sessions"),
                patch.object(roadmap, "HERMES_CRON_OUTPUT_ROOT", repo_root / "missing-cron-output"),
            ):
                cards = roadmap.build_report_process_cards(
                    repo_root,
                    {"fullName": "lanyusea/screeps"},
                    github_snapshot,
                    {},
                    DELIVERY_WINDOW_GENERATED_AT,
                )

        cards_by_label = {card["label"]: card for card in cards}
        self.assertEqual(cards_by_label["Deploys"]["value"], "unavailable")
        self.assertEqual(cards_by_label["Deploys"]["source"], "unavailable")
        self.assertIn("no accepted deploy evidence", cards_by_label["Deploys"]["detail"])
        self.assertEqual(cards_by_label["Private smoke"]["value"], "unavailable")
        self.assertEqual(cards_by_label["Private smoke"]["source"], "unavailable")
        self.assertIn("no accepted private smoke report", cards_by_label["Private smoke"]["detail"])

    def test_private_smoke_counts_only_live_accepted_json_reports_in_window(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            write_private_smoke_report(
                repo_root,
                "screeps-private-smoke-live-a/private-smoke-report-20260510T001000Z.json",
                private_smoke_report(
                    finished_at="2026-05-10T00:10:00Z",
                    report_path="/tmp/private-smoke-report-20260510T001000Z.json",
                ),
            )
            write_private_smoke_report(
                repo_root,
                "screeps-private-smoke-live-a/copy/private-smoke-report-20260510T001000Z.json",
                private_smoke_report(
                    finished_at="2026-05-10T00:10:00Z",
                    report_path="/tmp/private-smoke-report-20260510T001000Z.json",
                ),
            )
            write_private_smoke_report(
                repo_root,
                "screeps-private-smoke-live-b/private-smoke-report-20260511T001000Z.json",
                private_smoke_report(finished_at="2026-05-11T00:10:00Z"),
            )
            write_private_smoke_report(
                repo_root,
                "screeps-private-smoke-live-old/private-smoke-report-20260420T001000Z.json",
                private_smoke_report(finished_at="2026-04-20T00:10:00Z"),
            )
            write_private_smoke_report(
                repo_root,
                "screeps-private-smoke-dry-run/private-smoke-report-20260510T002000Z.json",
                private_smoke_report(dry_run=True, finished_at="2026-05-10T00:20:00Z"),
            )
            write_private_smoke_report(
                repo_root,
                "screeps-private-smoke-failed/private-smoke-report-20260510T003000Z.json",
                private_smoke_report(ok=False, finished_at="2026-05-10T00:30:00Z"),
            )

            summary = roadmap.summarize_private_smoke_evidence(repo_root, DELIVERY_WINDOW_GENERATED_AT)

        self.assertEqual(summary.count, 2)
        self.assertEqual(summary.candidate_count, 6)
        self.assertEqual(
            summary.evidence_ids,
            (
                "report:private-smoke-report-20260510T001000Z.json:2026-05-10T00:10:00Z",
                "report:private-smoke-report-20260511T001000Z.json:2026-05-11T00:10:00Z",
            ),
        )

    def test_report_process_cards_compute_agent_metrics_from_local_fixtures(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            codex_root = repo_root / "codex-sessions"
            cron_root = repo_root / "hermes-cron-output"
            write_evidence(
                repo_root,
                "official-screeps-deploy-20260501.json",
                deploy_evidence(timestamp="2026-05-01T03:00:00Z", commit="d" * 40, run_id="555"),
            )
            process_doc = repo_root / "docs" / "process" / "2026-05-01-private-smoke.md"
            process_doc.parent.mkdir(parents=True, exist_ok=True)
            process_doc.write_text("private-smoke-report-20260501.json\n", encoding="utf-8")
            write_private_smoke_report(
                repo_root,
                "screeps-private-smoke-live-20260501/private-smoke-report-20260501T031500Z.json",
                private_smoke_report(finished_at="2026-05-01T03:15:00Z"),
            )
            write_codex_session(
                codex_root / "2026" / "05" / "01" / "rollout-alpha.jsonl",
                [
                    session_meta_record("2026-05-01T00:00:00Z", repo_root),
                    token_count_record("2026-05-01T00:05:00Z", 100),
                    token_count_record("2026-05-01T00:10:00Z", 150),
                ],
            )
            write_codex_session(
                codex_root / "2026" / "05" / "01" / "rollout-beta.jsonl",
                [
                    session_meta_record("2026-05-01T01:00:00Z", "/root/screeps-worktrees/agent-metrics"),
                    token_count_record("2026-05-01T01:30:00Z", 75),
                ],
            )
            write_codex_session(
                codex_root / "2026" / "05" / "01" / "rollout-unrelated.jsonl",
                [
                    session_meta_record("2026-05-01T02:00:00Z", "/tmp/other-repo"),
                    token_count_record("2026-05-01T02:10:00Z", 999),
                ],
            )
            for relative in (
                "job-a/one-20260501T020000Z.md",
                "job-a/two-20260501T021000Z.md",
                "job-b/three-20260501T022000Z.md",
            ):
                output = cron_root / relative
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text("screeps roadmap fanout for lanyusea/screeps\n", encoding="utf-8")
            unrelated = cron_root / "job-c" / "unrelated.md"
            unrelated.parent.mkdir(parents=True, exist_ok=True)
            unrelated.write_text("other repository automation\n", encoding="utf-8")

            with (
                patch.object(roadmap, "CODEX_SESSION_ROOT", codex_root),
                patch.object(roadmap, "HERMES_CRON_OUTPUT_ROOT", cron_root),
                patch.object(roadmap, "run_text", return_value="42\n"),
                patch.object(
                    roadmap,
                    "fetch_all_prs",
                    return_value=([{"state": "MERGED"}, {"state": "OPEN"}], None),
                ),
                patch.object(
                    roadmap,
                    "fetch_all_issues",
                    return_value=([{"state": "OPEN"}, {"state": "CLOSED"}, {"state": "OPEN"}], None),
                ),
            ):
                cards = roadmap.build_report_process_cards(
                    repo_root,
                    {"fullName": "lanyusea/screeps"},
                    {},
                    {},
                    GENERATED_AT,
                )

        cards_by_label = {card["label"]: card for card in cards}
        self.assertEqual([card["label"] for card in cards], [
            "Commits",
            "Issues",
            "PRs",
            "Deploys",
            "Private smoke",
            "Agent tokens",
            "Codex runtime",
            "Codex runs",
            "Cron runs",
            "Longest Codex run",
        ])
        self.assertEqual(cards_by_label["Commits"]["value"], 42)
        self.assertEqual(cards_by_label["Commits"]["source"], "git rev-list --count HEAD")
        self.assertEqual(cards_by_label["Issues"]["value"], 3)
        self.assertIn("2 open", cards_by_label["Issues"]["detail"])
        self.assertEqual(cards_by_label["PRs"]["value"], 2)
        self.assertIn("1 merged", cards_by_label["PRs"]["detail"])
        self.assertEqual(cards_by_label["Deploys"]["value"], 1)
        self.assertEqual(cards_by_label["Private smoke"]["value"], 1)
        self.assertEqual(cards_by_label["Agent tokens"]["value"], "225")
        self.assertEqual(cards_by_label["Agent tokens"]["rawValue"], 225)
        self.assertIn("latest token_count in 2/2 sessions", cards_by_label["Agent tokens"]["detail"])
        self.assertEqual(cards_by_label["Agent tokens"]["source"], "repo-attributed .codex/sessions/**/rollout-*.jsonl")
        self.assertEqual(cards_by_label["Codex runtime"]["value"], "40m")
        self.assertEqual(cards_by_label["Codex runtime"]["rawValueSeconds"], 2400)
        self.assertIn("first-to-last JSONL timestamps", cards_by_label["Codex runtime"]["detail"])
        self.assertEqual(cards_by_label["Codex runs"]["value"], "2")
        self.assertEqual(cards_by_label["Cron runs"]["value"], "3")
        self.assertIn("3 cron outputs across 2 jobs", cards_by_label["Cron runs"]["detail"])
        self.assertEqual(cards_by_label["Longest Codex run"]["value"], "30m")
        self.assertEqual(cards_by_label["Longest Codex run"]["rawValueSeconds"], 1800)
        self.assertIn("maximum first-to-last JSONL timestamp span", cards_by_label["Longest Codex run"]["detail"])

    def test_report_process_cards_hide_cached_issue_pr_counts_when_github_unavailable(self) -> None:
        cached_page_data = {
            "report": {
                "processCards": [
                    {
                        "label": "Issues",
                        "value": 210,
                        "rawValue": 210,
                        "detail": "210 total issues",
                        "delta": "+0",
                        "source": "cached",
                    },
                    {
                        "label": "PRs",
                        "value": 248,
                        "rawValue": 248,
                        "detail": "248 total PRs",
                        "delta": "+0",
                        "source": "cached",
                    },
                ]
            }
        }
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            with (
                patch.object(roadmap, "run_text", return_value="42\n"),
                patch.object(
                    roadmap,
                    "fetch_all_prs",
                    return_value=([], {"message": "unavailable", "exitCode": 1}),
                ),
                patch.object(
                    roadmap,
                    "fetch_all_issues",
                    return_value=([], {"message": "unavailable", "exitCode": 1}),
                ),
                patch.object(roadmap, "CODEX_SESSION_ROOT", repo_root / "missing-codex-sessions"),
                patch.object(roadmap, "HERMES_CRON_OUTPUT_ROOT", repo_root / "missing-cron-output"),
                patch.object(roadmap, "summarize_official_deploy_evidence", return_value=roadmap.OfficialDeployEvidenceSummary(0)),
                patch.object(roadmap, "summarize_private_smoke_evidence", return_value=roadmap.PrivateSmokeEvidenceSummary(0)),
            ):
                cards = roadmap.build_report_process_cards(
                    repo_root,
                    {"fullName": "lanyusea/screeps"},
                    {},
                    cached_page_data,
                )

        self.assertEqual([card["label"] for card in cards], [
            "Commits",
            "Issues",
            "PRs",
            "Deploys",
            "Private smoke",
            "Agent tokens",
            "Codex runtime",
            "Codex runs",
            "Cron runs",
            "Longest Codex run",
        ])
        cards_by_label = {card["label"]: card for card in cards}
        expected_commands = {"Issues": "gh issue list", "PRs": "gh pr list"}
        for label, command in expected_commands.items():
            with self.subTest(label=label):
                card = cards_by_label[label]
                self.assertEqual(card["value"], "unavailable")
                self.assertEqual(card["delta"], "n/a")
                self.assertEqual(card["source"], "unavailable")
                self.assertNotIn("rawValue", card)
                self.assertIn(command, card["detail"])
                self.assertIn("unavailable", card["detail"])

    def test_report_process_cards_ignore_unattributed_host_global_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            codex_root = repo_root / "codex-sessions"
            cron_root = repo_root / "hermes-cron-output"
            write_codex_session(
                codex_root / "2026" / "05" / "01" / "rollout-global.jsonl",
                [
                    {"timestamp": "2026-05-01T00:00:00Z", "type": "session_meta", "payload": {}},
                    {
                        "timestamp": "2026-05-01T00:01:00Z",
                        "type": "turn_context",
                        "payload": {
                            "cwd": "/tmp/unrelated-repo",
                            "user_instructions": "Discuss lanyusea/screeps but do not mutate it.",
                        },
                    },
                    token_count_record("2026-05-01T00:10:00Z", 999),
                ],
            )
            output = cron_root / "job-a" / "one.md"
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text("Screeps roadmap fanout completed without repository metadata\n", encoding="utf-8")

            with (
                patch.object(roadmap, "CODEX_SESSION_ROOT", codex_root),
                patch.object(roadmap, "HERMES_CRON_OUTPUT_ROOT", cron_root),
                patch.object(roadmap, "run_text", return_value=""),
                patch.object(roadmap, "fetch_all_prs", return_value=([], {"message": "unavailable"})),
                patch.object(roadmap, "fetch_all_issues", return_value=([], {"message": "unavailable"})),
                patch.object(roadmap, "summarize_official_deploy_evidence", return_value=roadmap.OfficialDeployEvidenceSummary(0)),
                patch.object(roadmap, "summarize_private_smoke_evidence", return_value=roadmap.PrivateSmokeEvidenceSummary(0)),
            ):
                cards = roadmap.build_report_process_cards(repo_root, {"fullName": "lanyusea/screeps"}, {}, {})

        cards_by_label = {card["label"]: card for card in cards}
        self.assertEqual(cards_by_label["Agent tokens"]["value"], "unavailable")
        self.assertEqual(cards_by_label["Codex runs"]["value"], "unavailable")
        self.assertEqual(cards_by_label["Cron runs"]["value"], "unavailable")
        self.assertEqual(cards_by_label["Longest Codex run"]["value"], "unavailable")

    def test_agent_metrics_skip_bad_or_similarly_named_repo_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp) / "screeps"
            repo_root.mkdir()
            codex_root = Path(tmp) / "codex-sessions"
            cron_root = Path(tmp) / "hermes-cron-output"
            write_codex_session(
                codex_root / "2026" / "05" / "01" / "rollout-screeps-tools.jsonl",
                [
                    session_meta_record("2026-05-01T00:00:00Z", "/root/screeps-tools"),
                    token_count_record("2026-05-01T00:01:00Z", 999),
                ],
            )
            bad_path = codex_root / "2026" / "05" / "01" / "rollout-bad.jsonl"
            bad_path.parent.mkdir(parents=True, exist_ok=True)
            bad_path.write_bytes(
                b'{"timestamp":"2026-05-01T00:00:00Z","type":"session_meta","payload":{"cwd":"/tmp/bad'
                b'\x00'
                b'path"}}\n\xff\xfe\n'
            )
            write_codex_session(
                codex_root / "2026" / "05" / "01" / "rollout-good.jsonl",
                [
                    session_meta_record("2026-05-01T01:00:00Z", repo_root),
                    token_count_record("2026-05-01T01:03:00Z", 42),
                ],
            )
            unrelated = cron_root / "job-a" / "unrelated.md"
            unrelated.parent.mkdir(parents=True, exist_ok=True)
            unrelated.write_text("github.com/lanyusea/screeps-tools\n", encoding="utf-8")
            related = cron_root / "job-b" / "related-20260501T020000Z.md"
            related.parent.mkdir(parents=True, exist_ok=True)
            related.write_text("github.com/lanyusea/screeps\n", encoding="utf-8")

            attribution = roadmap.build_repo_attribution(repo_root, {"fullName": "lanyusea/screeps"})
            codex_metrics = roadmap.summarize_codex_sessions(codex_root, attribution)
            automation_metrics = roadmap.summarize_automation_runs(cron_root, attribution)

        self.assertEqual(codex_metrics.session_count, 1)
        self.assertEqual(codex_metrics.total_tokens, 42)
        self.assertEqual(codex_metrics.longest_elapsed_seconds, 180)
        self.assertEqual(automation_metrics.run_count, 1)
        self.assertEqual(automation_metrics.job_count, 1)

    def test_report_groups_visible_work_by_project_domain(self) -> None:
        repo = {
            "fullName": "lanyusea/screeps",
            "url": "https://github.com/lanyusea/screeps",
            "projectUrl": "https://github.com/users/lanyusea/projects/3",
        }
        github_snapshot = {
            "sourceMode": "live",
            "projectItemsSource": "live",
            "projectItems": [
                {
                    "type": "Issue",
                    "number": 29,
                    "title": "P1 runtime monitor delivery",
                    "url": "https://github.com/lanyusea/screeps/issues/29",
                    "status": "Ready",
                    "priority": "P1",
                    "domain": "Runtime monitor",
                    "nextAction": "Persist runtime summary evidence.",
                },
                {
                    "type": "Issue",
                    "number": 59,
                    "title": "Gameplay Evolution review loop",
                    "url": "https://github.com/lanyusea/screeps/issues/59",
                    "status": "In progress",
                    "priority": "P1",
                    "domain": "Gameplay Evolution",
                    "nextAction": "Refresh roadmap decisions from game-result evidence.",
                },
                {
                    "type": "Issue",
                    "number": 63,
                    "title": "Official MMO release cadence",
                    "url": "https://github.com/lanyusea/screeps/issues/63",
                    "status": "In review",
                    "priority": "P1",
                    "domain": "Release/deploy",
                    "nextAction": "Record deployment evidence.",
                },
                {
                    "type": "Issue",
                    "number": 165,
                    "title": "Territory wording should not choose an old static track",
                    "url": "https://github.com/lanyusea/screeps/issues/165",
                    "status": "Ready",
                    "priority": "P1",
                    "domain": "Bot capability",
                    "nextAction": "Prefer spawn refill before extension top-off.",
                },
                {
                    "type": "Issue",
                    "number": 223,
                    "title": "Foundation wording should not choose a delivery lane",
                    "url": "https://github.com/lanyusea/screeps/issues/223",
                    "status": "Ready",
                    "priority": "P1",
                    "domain": "Territory/Economy",
                    "nextAction": "Extend territory control opportunities.",
                },
                {
                    "type": "Issue",
                    "number": 421,
                    "title": "Runtime monitor title should not be guessed",
                    "url": "https://github.com/lanyusea/screeps/issues/421",
                    "status": "Ready",
                    "priority": "P1",
                    "nextAction": "This item has no explicit Project Domain.",
                },
                {
                    "type": "Issue",
                    "number": 422,
                    "title": "Official deploy title should not override an unknown domain",
                    "url": "https://github.com/lanyusea/screeps/issues/422",
                    "status": "Ready",
                    "priority": "P1",
                    "domain": "Official release",
                    "nextAction": "This item has an unrecognized Project Domain value.",
                },
            ],
            "issues": [],
            "pullRequests": [],
            "roadmapCards": [],
        }

        roadmap_cards = roadmap.build_report_roadmap_cards(github_snapshot, repo)
        domain_board = roadmap.build_report_domain_kanban(github_snapshot)

        self.assertEqual([card["title"] for card in roadmap_cards], list(roadmap.REPORT_ROADMAP_DOMAIN_ORDER))
        self.assertNotIn("Docs/process", [card["title"] for card in roadmap_cards])
        self.assertEqual([column["title"] for column in domain_board], list(roadmap.PROJECT_DOMAIN_ORDER))
        self.assertIn("Docs/process", [column["title"] for column in domain_board])

        runtime_column = next(column for column in domain_board if column["title"] == "Runtime monitor")
        gameplay_column = next(column for column in domain_board if column["title"] == "Gameplay Evolution")
        release_column = next(column for column in domain_board if column["title"] == "Release/deploy")
        bot_column = next(column for column in domain_board if column["title"] == "Bot capability")
        territory_column = next(column for column in domain_board if column["title"] == "Territory/Economy")
        runtime_card = next(card for card in roadmap_cards if card["title"] == "Runtime monitor")
        release_card = next(card for card in roadmap_cards if card["title"] == "Release/deploy")

        self.assertEqual(runtime_card["totalItems"], 1)
        self.assertEqual(release_card["totalItems"], 1)
        self.assertEqual([item["number"] for item in runtime_column["items"]], [29])
        self.assertEqual([item["number"] for item in gameplay_column["items"]], [59])
        self.assertEqual([item["number"] for item in release_column["items"]], [63])
        self.assertEqual([item["number"] for item in bot_column["items"]], [165])
        self.assertEqual([item["number"] for item in territory_column["items"]], [223])

    def test_project_data_live_gate_uses_project_specific_signals(self) -> None:
        self.assertTrue(
            roadmap.github_project_data_is_live(
                {"sourceMode": "live", "fetched": True, "fetchErrors": [], "projectItemsSource": "live"}
            )
        )
        self.assertTrue(
            roadmap.github_project_data_is_live(
                {
                    "sourceMode": "cached",
                    "fetched": False,
                    "fetchErrors": [{"source": "issues"}, {"source": "pullRequests"}],
                    "projectItemsSource": "live",
                }
            )
        )

        stale_snapshots = [
            {"sourceMode": "cached", "fetched": False, "fetchErrors": [], "projectItemsSource": "cached"},
            {"sourceMode": "live", "fetched": True, "fetchErrors": [{"source": "project"}], "projectItemsSource": "live"},
            {"sourceMode": "live", "fetched": True, "fetchErrors": ["project"], "projectItemsSource": "live"},
            {"sourceMode": "live", "fetched": True, "fetchErrors": [], "projectItemsSource": "cached"},
            {"sourceMode": "live", "fetched": True, "fetchErrors": [], "projectItemsSource": "unavailable"},
            {"sourceMode": "live", "fetched": True, "fetchErrors": []},
        ]
        for snapshot in stale_snapshots:
            with self.subTest(snapshot=snapshot):
                self.assertFalse(roadmap.github_project_data_is_live(snapshot))

    def test_report_domain_sections_hide_cached_project_items_when_github_stale(self) -> None:
        repo = {
            "fullName": "lanyusea/screeps",
            "url": "https://github.com/lanyusea/screeps",
            "projectUrl": "https://github.com/users/lanyusea/projects/3",
        }
        github_snapshot = {
            "sourceMode": "cached",
            "fetched": False,
            "fetchErrors": [{"source": "project", "message": "command failed"}],
            "projectItemsSource": "cached",
            "projectItems": [
                {
                    "type": "Issue",
                    "number": 29,
                    "title": "Cached runtime monitor item",
                    "url": "https://github.com/lanyusea/screeps/issues/29",
                    "status": "Done",
                    "priority": "P1",
                    "domain": "Runtime monitor",
                    "nextAction": "This cached current-looking action must not render.",
                }
            ],
            "issues": [],
            "pullRequests": [],
            "roadmapCards": [],
        }

        roadmap_cards = roadmap.build_report_roadmap_cards(github_snapshot, repo)
        domain_board = roadmap.build_report_domain_kanban(github_snapshot)

        self.assertEqual([card["title"] for card in roadmap_cards], list(roadmap.REPORT_ROADMAP_DOMAIN_ORDER))
        runtime_card = next(card for card in roadmap_cards if card["title"] == "Runtime monitor")
        self.assertIsNone(runtime_card["progress"])
        self.assertIsNone(runtime_card["totalItems"])
        self.assertIn("Stale - Project data unavailable", runtime_card["status"])
        self.assertIn("Source: cached", runtime_card["status"])
        self.assertIn("cached Project state is hidden", runtime_card["next"])
        self.assertNotIn("current-looking", runtime_card["next"])

        runtime_column = next(column for column in domain_board if column["title"] == "Runtime monitor")
        self.assertEqual(len(runtime_column["items"]), 1)
        self.assertEqual(runtime_column["items"][0]["title"], "Stale - Project data unavailable")
        self.assertIn("Source: cached", runtime_column["items"][0]["description"])
        self.assertNotEqual(runtime_column["items"][0].get("number"), 29)

    def test_fetch_github_snapshot_marks_cached_project_items_when_project_fetch_fails(self) -> None:
        cached_snapshot = {
            "projectItems": [
                {
                    "type": "Issue",
                    "number": 935,
                    "title": "Cached Project item",
                    "labels": ["roadmap"],
                    "status": "In progress",
                    "domain": "Change-control",
                }
            ]
        }

        def fake_run_json(command: list[str], cwd: Path, timeout: int = 30) -> tuple[Any | None, dict[str, Any] | None]:
            del cwd, timeout
            if command[:3] == ["gh", "issue", "list"]:
                return [], None
            if command[:3] == ["gh", "pr", "list"]:
                return [], None
            if command[:3] == ["gh", "project", "item-list"]:
                return None, {"command": command[:4], "exitCode": 1, "message": "command failed"}
            raise AssertionError(f"unexpected command: {command}")

        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(roadmap, "run_json", side_effect=fake_run_json):
                snapshot = roadmap.fetch_github_snapshot(
                    Path(tmp),
                    "lanyusea/screeps",
                    "lanyusea",
                    3,
                    cached_snapshot,
                )

        self.assertFalse(snapshot["fetched"])
        self.assertEqual(snapshot["sourceMode"], "cached")
        self.assertEqual(snapshot["projectItemsSource"], "cached")
        self.assertEqual(snapshot["fetchErrors"][0]["source"], "project")
        self.assertEqual(snapshot["projectItems"][0]["number"], 935)
        self.assertTrue(snapshot["projectItems"][0]["staleSource"])
        self.assertEqual(snapshot["projectItems"][0]["sourceMode"], "cached")
        self.assertEqual(snapshot["projectItems"][0]["sourceCollection"], "projectItems")
        self.assertNotIn(935, [card.get("number") for card in snapshot["roadmapCards"]])
        self.assertNotIn(935, [card.get("number") for card in snapshot["kanban"]["cards"]])

    def test_project_domain_requires_explicit_recognized_value(self) -> None:
        self.assertEqual(roadmap.project_domain({"domain": "runtime monitor"}), "Runtime monitor")
        self.assertEqual(roadmap.project_domain({"Project Domain": "bot capability"}), "Bot capability")
        self.assertEqual(
            roadmap.project_domain({"title": "Runtime monitor delivery", "labels": ["roadmap"]}),
            "",
        )
        self.assertEqual(
            roadmap.project_domain({"domain": "Runtime delivery", "title": "Official deploy"}),
            "",
        )
        self.assertEqual(
            roadmap.project_domain({"Project Domain": "Runtime delivery", "domain": "Runtime monitor"}),
            "",
        )

        normalized = roadmap.normalize_project_item(
            {
                "type": "Issue",
                "number": 9001,
                "title": "Runtime monitor delivery",
                "labels": ["roadmap"],
            }
        )
        self.assertEqual(normalized["domain"], "Runtime monitor")
        self.assertEqual(normalized["domainSource"], "heuristic")
        self.assertEqual(roadmap.project_domain(normalized), "")

    def test_visible_report_sections_use_project_domain_language(self) -> None:
        data = {
            "title": roadmap.PAGE_TITLE,
            "format": roadmap.REPORT_FORMAT,
            "generatedAt": "2026-04-28T00:00:00Z",
            "generatedAtCst": "2026-04-28 08:00:00 CST",
            "repo": {
                "fullName": "lanyusea/screeps",
                "url": "https://github.com/lanyusea/screeps",
                "projectUrl": "https://github.com/users/lanyusea/projects/3",
            },
            "assets": {"logo": ""},
            "report": {
                "kpiCards": [],
                "roadmapCards": [
                    {
                        "title": domain,
                        "goal": roadmap.PROJECT_DOMAIN_GOALS[domain],
                        "next": "No current GitHub/Project evidence available.",
                        "progress": None,
                        "status": "No Project Domain items observed",
                        "url": "",
                    }
                    for domain in roadmap.REPORT_ROADMAP_DOMAIN_ORDER
                ],
                "domainKanban": [{"title": domain, "items": []} for domain in roadmap.PROJECT_DOMAIN_ORDER],
                "processCards": [],
            },
        }

        html = roadmap.render_html(data)
        roadmap_section = html.split("03 Project Domain Board", 1)[0]
        kanban_section = html.split("03 Project Domain Board", 1)[1]

        self.assertIn("02 Project Domains", html)
        self.assertIn("03 Project Domain Board", html)
        self.assertNotIn("Docs/process", roadmap_section)
        self.assertIn("Docs/process", kanban_section)
        self.assertIn(
            ".kanban-grid {\n  display: grid;\n  grid-template-columns: repeat(5, minmax(0, 1fr));",
            html,
        )
        self.assertIn(
            ".kanban-grid {\n    overflow-x: auto;\n    grid-template-columns: repeat(5, minmax(190px, 1fr));",
            html,
        )
        self.assertNotIn("repeat(7,", html)
        self.assertNotIn("02 Development Roadmap - Six Tracks", html)
        self.assertNotIn("03 Gameplay Strategy Kanban", html)
        self.assertNotIn("04 Foundation Delivery Kanban", html)
        self.assertNotIn("Resource Economy", html)
        self.assertNotIn("Reliability / P0", html)
        self.assertNotIn("Foundation Gates", html)


if __name__ == "__main__":
    unittest.main()
