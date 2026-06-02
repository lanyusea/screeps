#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("screeps-runtime-monitor.py")
sys.path.insert(0, str(MODULE_PATH.parent))
SPEC = importlib.util.spec_from_file_location("screeps_runtime_monitor_script", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"could not load {MODULE_PATH}")
monitor = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = monitor
SPEC.loader.exec_module(monitor)


NO_ALERT_FIXTURE = {
    "ok": True,
    "mode": "alert",
    "alert": False,
    "reasons": [],
    "rooms": ["shardX/E26S49"],
    "warnings": [],
}

HOSTILE_ALERT_FIXTURE = {
    "ok": True,
    "mode": "alert",
    "alert": True,
    "reasons": [
        {
            "kind": "hostile_creep",
            "room": "shardX/E26S49",
            "object_id": "hostile-1",
            "owner": "Invader",
            "x": 20,
            "y": 21,
            "message": "hostile creep visible: Invader at 20,21",
        }
    ],
    "rooms": ["shardX/E26S49"],
}

ROOM_DEAD_ALERT_FIXTURE = {
    "ok": True,
    "mode": "alert",
    "alert": True,
    "reasons": [
        {
            "kind": "room_dead",
            "room": "shardX/E26S49",
            "current_owned_spawns": 0,
            "current_owned_creeps": 0,
            "message": "room has no owned creeps and no owned spawn recovery path",
        }
    ],
    "rooms": ["shardX/E26S49"],
}

HEALTHY_ALERT_FIXTURE = {
    "ok": True,
    "mode": "alert",
    "alert": False,
    "reasons": [],
    "rooms": ["shardX/E26S49"],
    "room_summaries": [
        {
            "room": "shardX/E26S49",
            "owned_creeps": 3,
            "owned_spawns": 1,
            "creeps": 3,
            "spawns": 1,
            "owner": "owner",
        }
    ],
    "warnings": [],
}

EXPANSION_BOOTSTRAP_NO_ALERT_FIXTURE = {
    "ok": True,
    "mode": "alert",
    "alert": False,
    "reasons": [],
    "rooms": ["shardX/E17S59", "shardX/E23S49"],
    "room_summaries": [
        {
            "room": "shardX/E17S59",
            "name": "E17S59",
            "owned_creeps": 13,
            "owned_spawns": 1,
            "creeps": 13,
            "spawns": 1,
            "hostiles": 0,
            "structures": 35,
            "owner": "lanyusea",
        },
        {
            "room": "shardX/E23S49",
            "name": "E23S49",
            "owned_creeps": 4,
            "owned_spawns": 0,
            "creeps": 4,
            "spawns": 0,
            "hostiles": 0,
            "structures": 1,
            "owner": "lanyusea",
        },
    ],
    "warnings": [],
}


PRIVATE_SMOKE_PHASES = [
    "host-port-preflight",
    "prepare-workdir",
    "prepare-map",
    "code-artifact",
    "compose-detected",
    "compose-up",
    "wait-http",
    "reset-data",
    "import-map",
    "restart-screeps",
    "wait-http-after-import",
    "resume-simulation",
    "register-user",
    "signin",
    "upload-code",
    "roundtrip-code",
    "place-spawn",
    "user-overview",
    "room-overview",
    "poll-stats",
    "mongo-summary",
]


def clean_private_smoke_fixture() -> dict[str, object]:
    phases = [{"name": name, "ok": True, "details": {}} for name in PRIVATE_SMOKE_PHASES]
    phase_by_name = {str(phase["name"]): phase for phase in phases}
    phase_by_name["poll-stats"]["details"] = {
        "ok": True,
        "samples": 2,
        "criteria": {"min_creeps": 1},
        "first": {
            "gametime": 6,
            "ownedRooms": 1,
            "totalRooms": 169,
            "user": {"username": "smoke", "rooms": 1, "creeps": 0},
        },
        "last": {
            "gametime": 31,
            "ownedRooms": 1,
            "totalRooms": 169,
            "user": {"username": "smoke", "rooms": 1, "creeps": 1},
        },
    }
    phase_by_name["mongo-summary"]["details"] = {
        "ok": True,
        "summary": {
            "room": "E1S1",
            "user": {"username": "smoke", "id": "user-1"},
            "counts": {"controller": 1, "creep": 1, "mineral": 1, "source": 2, "spawn": 1},
            "spawns": [{"name": "Spawn1", "x": 20, "y": 20, "hits": 5000, "hitsMax": 5000, "user": "user-1"}],
            "creeps": [{"name": "worker-E1S1-7", "x": 10, "y": 14, "body": ["work", "carry", "move"], "user": "user-1"}],
            "controller": {"level": 1, "x": 15, "y": 12, "user": "user-1"},
        },
    }
    return {
        "ok": True,
        "dry_run": False,
        "started_at": "2026-04-28T10:58:58Z",
        "finished_at": "2026-04-28T11:01:11Z",
        "smoke": {
            "username": "smoke",
            "room": "E1S1",
            "shard": "shardX",
            "spawn": {"name": "Spawn1", "x": 20, "y": 20},
            "branch": "default",
        },
        "phases": phases,
    }


def make_snapshot(objects: dict[str, dict[str, object]], tick: int | str | None = 1) -> monitor.RoomSnapshot:
    return monitor.RoomSnapshot(
        ref=monitor.RoomRef("shardX", "E26S49"),
        terrain="0" * monitor.TERRAIN_CELLS,
        objects=monitor.normalize_objects(objects),
        tick=tick,
        owner="owner",
        info={},
    )


def make_owned_worker_room_snapshot(room: str, tick: int) -> monitor.RoomSnapshot:
    return monitor.RoomSnapshot(
        ref=monitor.RoomRef("shardX", room),
        terrain="0" * monitor.TERRAIN_CELLS,
        objects=monitor.normalize_objects(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "lanyusea"},
                    "x": 17,
                    "y": 24,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "worker1": {
                    "type": "creep",
                    "my": True,
                    "owner": {"username": "lanyusea"},
                    "name": "WorkerA",
                    "memory": {"role": "worker"},
                },
                "site1": {
                    "type": "constructionSite",
                    "my": True,
                    "owner": {"username": "lanyusea"},
                    "structureType": "extension",
                    "progress": 0,
                    "progressTotal": 4500,
                    "x": 19,
                    "y": 24,
                },
            }
        ),
        tick=tick,
        owner="lanyusea",
        info={"energyAvailable": 1650},
        expected_owner="lanyusea",
    )


def worker_deadlock_runtime_summary_payload(
    room: str,
    tick: int,
    productive_assignment_count: int,
    blocked_detail: str | None,
) -> dict[str, object]:
    productive_task_count = max(0, min(2, productive_assignment_count))
    task_counts = {
        "harvest": 0,
        "transfer": 0,
        "build": productive_task_count,
        "repair": 0,
        "upgrade": 0,
        "none": max(0, 2 - productive_task_count),
    }
    worker_assignment_evidence = {
        "source": "runtime-summary",
        "available": True,
        "tick": tick,
        "workerCount": 2,
        "assignedTaskCount": productive_assignment_count,
        "productiveAssignmentCount": productive_assignment_count,
    }
    productive_energy: dict[str, object] = {
        "constructionSiteCount": 1,
        "pendingBuildProgress": 4500,
        "productiveAssignmentCount": productive_assignment_count,
    }
    room_summary: dict[str, object] = {
        "roomName": room,
        "shard": "shardX",
        "workerAssignmentEvidenceAvailable": True,
        "workerAssignmentEvidence": worker_assignment_evidence,
        "workerCount": 2,
        "taskCounts": task_counts,
        "constructionSiteCount": 1,
        "pendingBuildProgress": 4500,
        "productiveAssignmentCount": productive_assignment_count,
        "resources": {"productiveEnergy": productive_energy},
    }
    if blocked_detail is not None:
        room_summary["workerAssignmentBlockedDetail"] = blocked_detail
        room_summary["workerAssignmentBlockedWorkers"] = [{"name": "WorkerA", "task": "build", "carriedEnergy": 0}]
        productive_energy["workerAssignmentBlockedDetail"] = blocked_detail
    return {"type": "runtime-summary", "tick": tick, "rooms": [room_summary]}


def make_worker_assignment_gap_metrics() -> monitor.RoomSummaryMetrics:
    return monitor.RoomSummaryMetrics(
        structures=[],
        controller_summary={},
        owned_creep_objects=[],
        task_counts={"harvest": 0, "transfer": 0, "build": 0, "repair": 0, "upgrade": 0},
        worker_assignment_evidence_available=True,
        construction_sites=[{"type": "constructionSite"}],
        pending_build_progress=50,
        build_carried_energy=0,
        build_blocked_reason=monitor.WORKER_ASSIGNMENT_GAP_BLOCKED_REASON,
        construction_deadlock_ticks=1,
        extension_count=1,
        extension_capacity_contribution=50,
        extension_construction_site_count=0,
        extension_pending_build_progress=0,
        stored_energy=0,
        cpu_used=None,
        cpu_bucket=None,
        rcl_level=2,
    )


class WorldProfileDefaultsTest(unittest.TestCase):
    def test_persistent_profile_preserves_monitor_defaults(self) -> None:
        self.assertEqual(monitor.DEFAULT_OUT_DIR, Path("/root/screeps/runtime-artifacts/screeps-monitor"))
        self.assertEqual(monitor.DEFAULT_STATE_FILE, Path("/root/.hermes/screeps-runtime-monitor/state.json"))
        self.assertEqual(monitor.DEFAULT_CACHE_DIR, Path("/root/.hermes/screeps-runtime-monitor/terrain-cache"))
        self.assertEqual(
            monitor.DEFAULT_RUNTIME_SUMMARY_OUT_DIR,
            Path("/root/screeps/runtime-artifacts/runtime-summary-console"),
        )

        with mock.patch.dict(monitor.os.environ, {"SCREEPS_AUTH_TOKEN": "token"}, clear=True):
            summary_args = monitor.build_parser().parse_args(["summary"])
            alert_args = monitor.build_parser().parse_args(["alert"])
            ctx = monitor.context_from_env(summary_args.world_profile)

        self.assertEqual(summary_args.world_profile, "persistent")
        self.assertEqual(Path(summary_args.out_dir), monitor.DEFAULT_OUT_DIR)
        self.assertEqual(Path(summary_args.runtime_summary_out_dir), monitor.DEFAULT_RUNTIME_SUMMARY_OUT_DIR)
        self.assertEqual(alert_args.world_profile, "persistent")
        self.assertEqual(Path(alert_args.out_dir), monitor.DEFAULT_OUT_DIR)
        self.assertEqual(Path(alert_args.runtime_summary_dir), monitor.DEFAULT_RUNTIME_SUMMARY_OUT_DIR)
        self.assertEqual(ctx.base_http, monitor.DEFAULT_API_URL)
        self.assertEqual(ctx.default_shard, monitor.DEFAULT_SHARD)
        self.assertEqual(ctx.default_room, monitor.DEFAULT_ROOM)
        self.assertEqual(ctx.state_file, monitor.DEFAULT_STATE_FILE)
        self.assertEqual(ctx.cache_dir, monitor.DEFAULT_CACHE_DIR)

    def test_seasonal_profile_isolates_monitor_defaults(self) -> None:
        with mock.patch.dict(monitor.os.environ, {"SCREEPS_AUTH_TOKEN": "token"}, clear=True):
            summary_args = monitor.build_parser().parse_args(["summary", "--world-profile", "seasonal"])
            alert_args = monitor.build_parser().parse_args(["alert", "--world-profile", "seasonal"])
            ctx = monitor.context_from_env(summary_args.world_profile)

        self.assertEqual(summary_args.world_profile, "seasonal")
        self.assertEqual(Path(summary_args.out_dir), Path("/root/screeps/runtime-artifacts/seasonal/screeps-monitor"))
        self.assertEqual(
            Path(summary_args.runtime_summary_out_dir),
            Path("/root/screeps/runtime-artifacts/seasonal/runtime-summary-console"),
        )
        self.assertEqual(alert_args.world_profile, "seasonal")
        self.assertEqual(Path(alert_args.out_dir), Path("/root/screeps/runtime-artifacts/seasonal/screeps-monitor"))
        self.assertEqual(
            Path(alert_args.runtime_summary_dir),
            Path("/root/screeps/runtime-artifacts/seasonal/runtime-summary-console"),
        )
        self.assertEqual(ctx.base_http, "https://screeps.com/season")
        self.assertEqual(ctx.default_shard, "shardSeason")
        self.assertEqual(ctx.default_room, monitor.DEFAULT_ROOM)
        self.assertEqual(ctx.state_file, Path("/root/.hermes/screeps-seasonal-runtime-monitor/state.json"))
        self.assertEqual(ctx.cache_dir, Path("/root/.hermes/screeps-seasonal-runtime-monitor/terrain-cache"))

    def test_profile_env_and_explicit_overrides_win_for_monitor(self) -> None:
        with mock.patch.dict(
            monitor.os.environ,
            {
                "SCREEPS_AUTH_TOKEN": "token",
                "SCREEPS_WORLD_PROFILE": "seasonal",
                "SCREEPS_API_URL": "https://example.invalid/custom",
                "SCREEPS_SHARD": "shardCustom",
                "SCREEPS_MONITOR_STATE_FILE": "/tmp/custom-state.json",
                "SCREEPS_MONITOR_CACHE_DIR": "/tmp/custom-cache",
                "SCREEPS_RUNTIME_SUMMARY_DIR": "/tmp/custom-runtime-summary",
            },
            clear=True,
        ):
            summary_args = monitor.build_parser().parse_args(
                [
                    "summary",
                    "--out-dir",
                    "/tmp/custom-monitor",
                    "--runtime-summary-out-dir",
                    "/tmp/custom-summary-out",
                ]
            )
            alert_args = monitor.build_parser().parse_args(["alert"])
            ctx = monitor.context_from_env(summary_args.world_profile)

        self.assertEqual(summary_args.world_profile, "seasonal")
        self.assertEqual(Path(summary_args.out_dir), Path("/tmp/custom-monitor"))
        self.assertEqual(Path(summary_args.runtime_summary_out_dir), Path("/tmp/custom-summary-out"))
        self.assertEqual(Path(alert_args.runtime_summary_dir), Path("/tmp/custom-runtime-summary"))
        self.assertEqual(ctx.base_http, "https://example.invalid/custom")
        self.assertEqual(ctx.default_shard, "shardCustom")
        self.assertEqual(ctx.state_file, Path("/tmp/custom-state.json"))
        self.assertEqual(ctx.cache_dir, Path("/tmp/custom-cache"))

    def test_invalid_monitor_world_profile_is_rejected(self) -> None:
        with mock.patch.dict(monitor.os.environ, {}, clear=True):
            with self.assertRaises(SystemExit):
                monitor.build_parser().parse_args(["summary", "--world-profile", "invalid"])

        with mock.patch.dict(monitor.os.environ, {"SCREEPS_WORLD_PROFILE": "invalid"}, clear=True):
            with self.assertRaises(SystemExit):
                monitor.build_parser().parse_args(["summary"])

    def test_forced_room_discovery_preserves_overview_refs_for_summary_disambiguation(self) -> None:
        ctx = monitor.RuntimeContext(
            base_http="https://screeps.com",
            token="token",
            default_shard="shardX",
            default_room="E29N55",
            owner=None,
            owner_id=None,
            state_file=Path("/tmp/state.json"),
            cache_dir=Path("/tmp/cache"),
            debounce_seconds=300,
            collection_attempts=1,
            collection_retry_delay_seconds=0,
        )
        overview = {
            "shards": {
                "shardSeason": {"rooms": ["E29N55"]},
                "shardX": {"rooms": ["E29N55"]},
            }
        }

        with mock.patch.object(monitor, "get_json", return_value=overview):
            rooms, returned_overview, warnings, overview_refs = monitor.discover_owned_rooms(
                ctx,
                monitor.RoomRef(shard="shardX", room="E29N55"),
            )

        self.assertEqual(rooms, [monitor.RoomRef(shard="shardX", room="E29N55")])
        self.assertIs(returned_overview, overview)
        self.assertEqual(warnings, [])
        self.assertEqual(
            overview_refs,
            [
                monitor.RoomRef(shard="shardSeason", room="E29N55"),
                monitor.RoomRef(shard="shardX", room="E29N55"),
            ],
        )


class TacticalResponseBridgeTest(unittest.TestCase):
    def test_no_alert_fixture_is_machine_readable_silent(self) -> None:
        report = monitor.build_tactical_response_report(NO_ALERT_FIXTURE)

        self.assertEqual(report["mode"], "tactical-response")
        self.assertFalse(report["emergency"])
        self.assertTrue(report["silent"])
        self.assertEqual(report["severity"], "none")
        self.assertEqual(report["categories"], [])
        self.assertEqual(report["scheduler"]["recommended_output"], "[SILENT]")
        self.assertFalse(report["scheduler"]["should_post"])

    def test_hostile_fixture_is_high_priority_tactical_emergency(self) -> None:
        report = monitor.build_tactical_response_report(HOSTILE_ALERT_FIXTURE)

        self.assertTrue(report["emergency"])
        self.assertFalse(report["silent"])
        self.assertEqual(report["severity"], "high")
        self.assertEqual(report["categories"], ["hostiles"])
        self.assertEqual(report["triggers"][0]["decision"], "owner_action_or_observe")
        self.assertTrue(report["scheduler"]["should_post"])
        self.assertEqual(report["scheduler"]["recommended_output"], "TACTICAL_EMERGENCY_REPORT")
        self.assertIn("capture_runtime_context", {action["id"] for action in report["next_actions"]})

    def test_room_dead_fixture_is_p0_critical_tactical_emergency(self) -> None:
        report = monitor.build_tactical_response_report(ROOM_DEAD_ALERT_FIXTURE)

        self.assertTrue(report["emergency"])
        self.assertFalse(report["silent"])
        self.assertEqual(report["severity"], "critical")
        self.assertEqual(report["priority"], "P0")
        self.assertIn("room_dead", report["categories"])
        self.assertIn("spawn_collapse", report["categories"])
        self.assertTrue(report["scheduler"]["should_post"])
        self.assertEqual(report["scheduler"]["priority"], "P0")
        self.assertEqual(report["scheduler"]["recommended_output"], "TACTICAL_EMERGENCY_REPORT")
        self.assertIn("start_autonomous_recovery", {action["id"] for action in report["next_actions"]})

    def test_hostile_room_dead_fixture_remains_p0_critical(self) -> None:
        fixture = copy.deepcopy(ROOM_DEAD_ALERT_FIXTURE)
        fixture["reasons"] = [*HOSTILE_ALERT_FIXTURE["reasons"], *fixture["reasons"]]

        report = monitor.build_tactical_response_report(fixture)

        self.assertTrue(report["emergency"])
        self.assertEqual(report["severity"], "critical")
        self.assertEqual(report["priority"], "P0")
        self.assertIn("hostiles", report["categories"])
        self.assertIn("room_dead", report["categories"])
        self.assertEqual(report["scheduler"]["recommended_output"], "TACTICAL_EMERGENCY_REPORT")

    def test_healthy_room_summary_fixture_stays_silent(self) -> None:
        report = monitor.build_tactical_response_report(HEALTHY_ALERT_FIXTURE)

        self.assertFalse(report["emergency"])
        self.assertTrue(report["silent"])
        self.assertEqual(report["severity"], "none")
        self.assertIsNone(report["priority"])
        self.assertEqual(report["scheduler"]["recommended_output"], "[SILENT]")

    def test_energy_buffer_unhealthy_alerts_on_second_consecutive_capture(self) -> None:
        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "worker-1": {
                    "type": "creep",
                    "my": True,
                    "owner": {"username": "owner"},
                    "name": "worker-1",
                    "x": 23,
                    "y": 25,
                },
            }
        )
        runtime_room = {
            "roomName": "E26S49",
            "energyBufferHealth": {"currentEnergy": 250, "threshold": 300, "healthy": False},
            "taskCounts": {"harvest": 1, "upgrade": 0, "build": 0, "transfer": 1},
        }
        previous = {"baseline_established": True, "owner": "owner"}

        first_emitted, first_suppressed, first_state = monitor.evaluate_room_alert(
            snapshot,
            previous,
            now=100,
            debounce_seconds=300,
            runtime_room_summary=runtime_room,
        )
        self.assertEqual(first_emitted, [])
        self.assertEqual(first_suppressed, [])
        self.assertEqual(first_state["rule_counts"][monitor.ENERGY_BUFFER_UNHEALTHY_KIND], 1)

        second_emitted, second_suppressed, second_state = monitor.evaluate_room_alert(
            snapshot,
            first_state,
            now=200,
            debounce_seconds=300,
            runtime_room_summary=runtime_room,
        )
        self.assertEqual([reason["kind"] for reason in second_emitted], [monitor.ENERGY_BUFFER_UNHEALTHY_KIND])
        self.assertEqual(second_suppressed, [])
        self.assertEqual(second_state["rule_counts"][monitor.ENERGY_BUFFER_UNHEALTHY_KIND], 2)

        report = monitor.build_tactical_response_report(
            {
                "ok": True,
                "mode": "alert",
                "alert": True,
                "reasons": second_emitted,
                "rooms": ["shardX/E26S49"],
            }
        )

        self.assertTrue(report["emergency"])
        self.assertFalse(report["silent"])
        self.assertEqual(report["severity"], "high")
        self.assertEqual(report["priority"], "P1")
        self.assertEqual(report["categories"], ["energy_buffer_unhealthy"])
        self.assertEqual(report["scheduler"]["recommended_output"], "TACTICAL_EMERGENCY_REPORT")
        trigger = report["triggers"][0]
        self.assertEqual(trigger["priority"], "P1")
        self.assertEqual(trigger["metadata"]["related_issues"], ["#906", "#907"])
        self.assertEqual({route["issue"] for route in trigger["metadata"]["routes_to"]}, {"#906", "#907"})

    def test_energy_buffer_unhealthy_transient_stays_silent(self) -> None:
        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "worker-1": {
                    "type": "creep",
                    "my": True,
                    "owner": {"username": "owner"},
                    "name": "worker-1",
                    "x": 23,
                    "y": 25,
                },
            }
        )
        unhealthy_room = {
            "roomName": "E26S49",
            "energyBufferHealth": {"currentEnergy": 250, "threshold": 300, "healthy": False},
            "taskCounts": {"harvest": 1, "upgrade": 0, "build": 0, "transfer": 1},
        }
        recovered_room = {
            "roomName": "E26S49",
            "energyBufferHealth": {"currentEnergy": 300, "threshold": 300, "healthy": True},
            "taskCounts": {"harvest": 1, "upgrade": 0, "build": 0, "transfer": 1},
        }

        first_emitted, _first_suppressed, first_state = monitor.evaluate_room_alert(
            snapshot,
            {"baseline_established": True, "owner": "owner"},
            now=100,
            debounce_seconds=300,
            runtime_room_summary=unhealthy_room,
        )
        self.assertEqual(first_emitted, [])

        second_emitted, second_suppressed, second_state = monitor.evaluate_room_alert(
            snapshot,
            first_state,
            now=200,
            debounce_seconds=300,
            runtime_room_summary=recovered_room,
        )
        self.assertEqual(second_emitted, [])
        self.assertEqual(second_suppressed, [])
        self.assertEqual(second_state["rule_counts"][monitor.ENERGY_BUFFER_UNHEALTHY_KIND], 0)

        report = monitor.build_tactical_response_report(
            {"ok": True, "mode": "alert", "alert": False, "reasons": second_emitted, "rooms": ["shardX/E26S49"]}
        )
        self.assertTrue(report["silent"])

    def test_energy_buffer_unhealthy_single_capture_reason_is_non_actionable(self) -> None:
        report = monitor.build_tactical_response_report(
            {
                "ok": True,
                "mode": "alert",
                "alert": True,
                "reasons": [
                    {
                        "kind": monitor.ENERGY_BUFFER_UNHEALTHY_KIND,
                        "room": "shardX/E26S49",
                        "consecutive": 1,
                        "energy_buffer_health": {"currentEnergy": 250, "threshold": 300, "healthy": False},
                        "task_counts": {"build": 0, "upgrade": 0},
                    }
                ],
            }
        )

        self.assertFalse(report["emergency"])
        self.assertTrue(report["silent"])
        self.assertEqual(report["triggers"], [])

    def test_construction_deadlock_metric_alerts_at_p1_and_escalates_to_p0(self) -> None:
        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "site1": {
                    "type": "constructionSite",
                    "my": True,
                    "owner": {"username": "owner"},
                    "structureType": "extension",
                    "progress": 0,
                    "progressTotal": 50,
                },
            }
        )
        runtime_room = {
            "roomName": "E26S49",
            "taskCounts": {"harvest": 1, "upgrade": 1, "build": 0, "transfer": 0},
            "constructionSiteCount": 1,
            "pendingBuildProgress": 50,
            "buildCarriedEnergy": 0,
            "constructionDeadlockTicks": monitor.CONSTRUCTION_DEADLOCK_P1_TICKS,
        }

        first_emitted, first_suppressed, first_state = monitor.evaluate_room_alert(
            snapshot,
            {"baseline_established": True, "owner": "owner"},
            now=100,
            debounce_seconds=300,
            runtime_room_summary=runtime_room,
        )

        self.assertEqual(first_suppressed, [])
        self.assertEqual([reason["kind"] for reason in first_emitted], [monitor.CONSTRUCTION_DEADLOCK_KIND])
        self.assertEqual(first_emitted[0]["priority"], "P1")
        self.assertEqual(first_emitted[0]["severity"], "high")
        self.assertEqual(first_emitted[0]["constructionDeadlockTicks"], monitor.CONSTRUCTION_DEADLOCK_P1_TICKS)

        critical_room = dict(runtime_room, constructionDeadlockTicks=monitor.CONSTRUCTION_DEADLOCK_P0_TICKS)
        second_emitted, second_suppressed, _second_state = monitor.evaluate_room_alert(
            snapshot,
            first_state,
            now=200,
            debounce_seconds=300,
            runtime_room_summary=critical_room,
        )

        self.assertEqual(second_suppressed, [])
        self.assertEqual([reason["kind"] for reason in second_emitted], [monitor.CONSTRUCTION_DEADLOCK_KIND])
        self.assertEqual(second_emitted[0]["priority"], "P0")
        self.assertEqual(second_emitted[0]["severity"], "critical")

        report = monitor.build_tactical_response_report(
            {
                "ok": True,
                "mode": "alert",
                "alert": True,
                "reasons": second_emitted,
                "rooms": ["shardX/E26S49"],
            }
        )

        self.assertTrue(report["emergency"])
        self.assertEqual(report["severity"], "critical")
        self.assertEqual(report["priority"], "P0")
        self.assertEqual(report["categories"], [monitor.CONSTRUCTION_DEADLOCK_KIND])
        trigger = report["triggers"][0]
        self.assertEqual(trigger["priority"], "P0")
        self.assertEqual(trigger["metadata"]["metric"], "constructionDeadlockTicks")
        self.assertEqual(trigger["metadata"]["thresholds"], {"P0": 500, "P1": 100})

    def test_cpu_bucket_critical_runtime_summary_alerts_health_gate_and_tactical_response(self) -> None:
        payload = {
            "type": "runtime-summary",
            "tick": 1200,
            "cpu": {
                "used": 30.14,
                "limit": 70,
                "bucket": 4,
                "pressure": "critical",
                "alerts": ["lowBucket"],
                "reasons": ["criticalBucket"],
                "lowBucketTicks": 4,
            },
            "rooms": [{"roomName": "E26S49", "shard": "shardX"}],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            (runtime_dir / "runtime-summary-console-20260529T001418Z.log").write_text(
                "#runtime-summary " + json.dumps(payload) + "\n",
                encoding="utf-8",
            )
            warnings: list[str] = []
            runtime_rooms = monitor.load_latest_runtime_room_summaries(
                runtime_dir,
                [monitor.RoomRef(shard="shardX", room="E26S49")],
                warnings,
            )

        self.assertEqual(warnings, [])
        runtime_room = runtime_rooms["shardX/E26S49"]
        self.assertEqual(runtime_room[monitor.RUNTIME_SUMMARY_CPU_METADATA_KEY]["pressure"], "critical")

        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "worker-1": {
                    "type": "creep",
                    "my": True,
                    "owner": {"username": "owner"},
                    "name": "worker-1",
                    "x": 23,
                    "y": 25,
                },
            }
        )
        emitted, suppressed, _next_state = monitor.evaluate_room_alert(
            snapshot,
            {"baseline_established": True, "owner": "owner"},
            now=100,
            debounce_seconds=300,
            runtime_room_summary=runtime_room,
        )

        self.assertEqual(suppressed, [])
        self.assertEqual([reason["kind"] for reason in emitted], [monitor.CPU_BUCKET_CRITICAL_KIND])
        cpu_reason = emitted[0]
        self.assertEqual(cpu_reason["priority"], "P0")
        self.assertEqual(cpu_reason["severity"], "critical")
        self.assertEqual(cpu_reason["cpuBucket"], 4)
        self.assertEqual(cpu_reason["pressure"], "critical")
        self.assertEqual(cpu_reason["alerts"], ["lowBucket"])

        alert_payload = {
            "ok": True,
            "mode": "alert",
            "alert": True,
            "reasons": emitted,
            "rooms": ["shardX/E26S49"],
        }
        health = monitor.evaluate_postdeploy_health_gate(
            {
                "ok": True,
                "mode": "summary",
                "room_summaries": [
                    {
                        "room": "shardX/E26S49",
                        "owned_creeps": 1,
                        "owned_spawns": 1,
                        "creeps": 1,
                        "spawns": 1,
                        "owner": "owner",
                        "cpuBucket": 4,
                    }
                ],
            },
            alert_payload,
        )
        self.assertFalse(health["ok"])
        self.assertIn(monitor.CPU_BUCKET_CRITICAL_KIND, [reason["kind"] for reason in health["reasons"]])

        report = monitor.build_tactical_response_report(alert_payload)
        self.assertTrue(report["emergency"])
        self.assertEqual(report["severity"], "critical")
        self.assertEqual(report["priority"], "P0")
        self.assertEqual(report["categories"], [monitor.CPU_BUCKET_CRITICAL_KIND])
        self.assertEqual(report["scheduler"]["recommended_output"], "TACTICAL_EMERGENCY_REPORT")
        trigger = report["triggers"][0]
        self.assertEqual(trigger["priority"], "P0")
        self.assertEqual(trigger["metadata"]["metric"], "cpu.bucket")
        self.assertEqual(trigger["metadata"]["thresholds"], {"P0": 100, "P1": 1000})

    def test_postdeploy_health_gate_enriches_cpu_fields_from_runtime_summary_artifact(self) -> None:
        payload = {
            "type": "runtime-summary",
            "tick": 1200,
            "cpu": {
                "used": 30.14,
                "limit": 70,
                "bucket": 4,
                "pressure": "critical",
                "reasons": ["criticalBucket"],
            },
            "rooms": [{"roomName": "E26S49", "shard": "shardX", "workerCount": 1}],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            artifact = Path(temp_dir) / "runtime-summary-monitor-20260529T001418Z.log"
            artifact.write_text("#runtime-summary " + json.dumps(payload) + "\n", encoding="utf-8")

            health = monitor.evaluate_postdeploy_health_gate(
                {
                    "ok": True,
                    "mode": "summary",
                    "room_summaries": [
                        {
                            "room": "shardX/E26S49",
                            "owned_creeps": 1,
                            "owned_spawns": 1,
                            "creeps": 1,
                            "spawns": 1,
                            "owner": "owner",
                        }
                    ],
                    "runtime_summary_artifact": str(artifact),
                },
                {"ok": True, "mode": "alert", "alert": False, "reasons": [], "rooms": ["shardX/E26S49"]},
            )

        self.assertFalse(health["ok"])
        cpu_reason = next(reason for reason in health["reasons"] if reason["kind"] == monitor.CPU_BUCKET_CRITICAL_KIND)
        self.assertEqual(cpu_reason["cpuBucket"], 4)
        self.assertEqual(cpu_reason["pressure"], "critical")

    def test_compact_cpu_summary_alerts_health_gate_and_tactical_response(self) -> None:
        old_room_payload = {
            "type": "runtime-summary",
            "tick": 1190,
            "rooms": [
                {
                    "roomName": "E26S49",
                    "shard": "shardX",
                    "workerCount": 3,
                    "taskCounts": {"harvest": 2, "transfer": 1, "build": 0, "repair": 0, "upgrade": 0, "none": 0},
                }
            ],
        }
        compact_cpu_payload = {
            "used": 30.14,
            "limit": 70,
            "bucket": 0,
            "pressure": "critical",
            "alerts": ["lowBucket"],
            "reasons": ["criticalBucket"],
            "lowBucketTicks": 4,
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            (runtime_dir / "runtime-summary-console-20260529T001000Z.log").write_text(
                "#runtime-summary " + json.dumps(old_room_payload) + "\n",
                encoding="utf-8",
            )
            (runtime_dir / "runtime-summary-console-20260529T001418Z.log").write_text(
                "#cpu-summary " + json.dumps(compact_cpu_payload) + "\n",
                encoding="utf-8",
            )
            warnings: list[str] = []
            runtime_rooms = monitor.load_latest_runtime_room_summaries(
                runtime_dir,
                [monitor.RoomRef(shard="shardX", room="E26S49")],
                warnings,
            )

        self.assertEqual(warnings, [])
        runtime_room = runtime_rooms["shardX/E26S49"]
        self.assertEqual(runtime_room["room"], "shardX/E26S49")
        self.assertEqual(runtime_room["workerCount"], 3)
        self.assertEqual(runtime_room["taskCounts"]["harvest"], 2)
        self.assertEqual(runtime_room["cpuBucket"], 0)
        self.assertEqual(runtime_room["cpuLimit"], 70)
        self.assertEqual(runtime_room[monitor.RUNTIME_SUMMARY_CPU_METADATA_KEY]["pressure"], "critical")
        self.assertEqual(runtime_room[monitor.RUNTIME_SUMMARY_CPU_METADATA_KEY]["reasons"], ["criticalBucket"])

        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "worker-1": {
                    "type": "creep",
                    "my": True,
                    "owner": {"username": "owner"},
                    "name": "worker-1",
                    "x": 23,
                    "y": 25,
                },
            }
        )
        emitted, suppressed, _next_state = monitor.evaluate_room_alert(
            snapshot,
            {"baseline_established": True, "owner": "owner"},
            now=100,
            debounce_seconds=300,
            runtime_room_summary=runtime_room,
        )

        self.assertEqual(suppressed, [])
        self.assertEqual([reason["kind"] for reason in emitted], [monitor.CPU_BUCKET_CRITICAL_KIND])
        self.assertEqual(emitted[0]["priority"], "P0")
        self.assertEqual(emitted[0]["severity"], "critical")
        self.assertEqual(emitted[0]["cpuBucket"], 0)

        alert_payload = {
            "ok": True,
            "mode": "alert",
            "alert": True,
            "reasons": emitted,
            "rooms": ["shardX/E26S49"],
        }
        health = monitor.evaluate_postdeploy_health_gate(
            {
                "ok": True,
                "mode": "summary",
                "room_summaries": [
                    {
                        "room": "shardX/E26S49",
                        "owned_creeps": 1,
                        "owned_spawns": 1,
                        "creeps": 1,
                        "spawns": 1,
                        "owner": "owner",
                    }
                ],
            },
            alert_payload,
        )

        self.assertFalse(health["ok"])
        active_alert = next(reason for reason in health["reasons"] if reason["kind"] == "postdeploy_active_alert")
        self.assertEqual(active_alert["source"]["kind"], monitor.CPU_BUCKET_CRITICAL_KIND)

        report = monitor.build_tactical_response_report(alert_payload)
        self.assertTrue(report["emergency"])
        self.assertEqual(report["severity"], "critical")
        self.assertEqual(report["priority"], "P0")
        self.assertEqual(report["categories"], [monitor.CPU_BUCKET_CRITICAL_KIND])

    def test_fresh_runtime_summary_cpu_fields_override_stale_compact_cpu_summary(self) -> None:
        compact_cpu_payload = {
            "used": 30.14,
            "limit": 70,
            "bucket": 0,
            "pressure": "critical",
            "reasons": ["criticalBucket"],
        }
        runtime_payload = {
            "type": "runtime-summary",
            "tick": 1200,
            "cpu": {"used": 6.5, "limit": 70, "bucket": 9000, "pressure": "normal"},
            "rooms": [
                {
                    "roomName": "E26S49",
                    "shard": "shardX",
                    "workerCount": 3,
                    "taskCounts": {"harvest": 2, "transfer": 1, "build": 0, "repair": 0, "upgrade": 0, "none": 0},
                }
            ],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            (runtime_dir / "runtime-summary-console-20260529T001000Z.log").write_text(
                "#cpu-summary " + json.dumps(compact_cpu_payload) + "\n",
                encoding="utf-8",
            )
            (runtime_dir / "runtime-summary-console-20260529T001418Z.log").write_text(
                "#runtime-summary " + json.dumps(runtime_payload) + "\n",
                encoding="utf-8",
            )
            warnings: list[str] = []
            runtime_rooms = monitor.load_latest_runtime_room_summaries(
                runtime_dir,
                [monitor.RoomRef(shard="shardX", room="E26S49")],
                warnings,
            )

        self.assertEqual(warnings, [])
        runtime_room = runtime_rooms["shardX/E26S49"]
        self.assertEqual(runtime_room["workerCount"], 3)
        self.assertEqual(runtime_room[monitor.RUNTIME_SUMMARY_CPU_METADATA_KEY]["bucket"], 9000)
        self.assertIsNone(monitor.detect_cpu_bucket_reason(monitor.RoomRef(shard="shardX", room="E26S49"), runtime_room))

    def test_newer_null_monitor_cpu_does_not_mask_persisted_cpu_alerts(self) -> None:
        cases = (
            (
                "top-level runtime-summary cpu",
                "#runtime-summary "
                + json.dumps(
                    {
                        "type": "runtime-summary",
                        "tick": 1200,
                        "cpu": {
                            "used": 29.42,
                            "limit": 70,
                            "bucket": 15,
                            "pressure": "critical",
                            "alerts": ["lowBucket"],
                            "reasons": ["criticalBucket"],
                            "lowBucketTicks": 1,
                        },
                        "rooms": [{"roomName": "E26S49", "shard": "shardX", "workerCount": 1}],
                    }
                )
                + "\n",
            ),
            (
                "room-level runtime-summary cpu",
                "#runtime-summary "
                + json.dumps(
                    {
                        "type": "runtime-summary",
                        "tick": 1200,
                        "rooms": [
                            {
                                "roomName": "E26S49",
                                "shard": "shardX",
                                "workerCount": 1,
                                "cpuUsed": 29.42,
                                "cpuBucket": 15,
                            }
                        ],
                    }
                )
                + "\n",
            ),
            (
                "compact cpu-summary",
                "#cpu-summary "
                + json.dumps(
                    {
                        "used": 29.42,
                        "limit": 70,
                        "bucket": 15,
                        "pressure": "critical",
                        "alerts": ["lowBucket"],
                        "reasons": ["criticalBucket"],
                        "lowBucketTicks": 1,
                    }
                )
                + "\n",
            ),
        )
        null_monitor_payload = {
            "type": "runtime-summary",
            "source": monitor.MONITOR_RUNTIME_SUMMARY_SOURCE,
            "tick": 1205,
            "cpu": {"used": None, "bucket": None},
            "rooms": [
                {
                    "roomName": "E26S49",
                    "shard": "shardX",
                    "workerCount": 3,
                    "taskCounts": {"harvest": 2, "transfer": 1, "build": 0, "repair": 0, "upgrade": 0, "none": 0},
                    "cpuUsed": None,
                    "cpuBucket": None,
                }
            ],
        }

        for name, persisted_cpu_line in cases:
            with self.subTest(name=name):
                with tempfile.TemporaryDirectory() as temp_dir:
                    runtime_dir = Path(temp_dir)
                    (runtime_dir / "runtime-summary-console-20260529T043738Z.log").write_text(
                        persisted_cpu_line,
                        encoding="utf-8",
                    )
                    (runtime_dir / "runtime-summary-monitor-20260529T045325Z.log").write_text(
                        "#runtime-summary " + json.dumps(null_monitor_payload) + "\n",
                        encoding="utf-8",
                    )
                    warnings: list[str] = []
                    runtime_rooms = monitor.load_latest_runtime_room_summaries(
                        runtime_dir,
                        [monitor.RoomRef(shard="shardX", room="E26S49")],
                        warnings,
                    )

                self.assertEqual(warnings, [])
                runtime_room = runtime_rooms["shardX/E26S49"]
                self.assertEqual(runtime_room["workerCount"], 3)
                self.assertEqual(runtime_room["taskCounts"]["harvest"], 2)

                reason = monitor.detect_cpu_bucket_reason(
                    monitor.RoomRef(shard="shardX", room="E26S49"),
                    runtime_room,
                )

                self.assertIsNotNone(reason)
                assert reason is not None
                self.assertEqual(reason["kind"], monitor.CPU_BUCKET_CRITICAL_KIND)
                self.assertEqual(reason["cpuBucket"], 15)

    def test_compact_cpu_summary_healthy_malformed_or_missing_stays_silent(self) -> None:
        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "worker-1": {
                    "type": "creep",
                    "my": True,
                    "owner": {"username": "owner"},
                    "name": "worker-1",
                    "x": 23,
                    "y": 25,
                },
            }
        )
        cases = (
            (
                "healthy",
                "#cpu-summary " + json.dumps({"used": 6.5, "bucket": 9000, "pressure": "normal"}) + "\n",
                False,
            ),
            ("malformed", "#cpu-summary {bad json\n", True),
            ("missing", "", False),
        )

        for name, content, expects_warning in cases:
            with self.subTest(name=name):
                with tempfile.TemporaryDirectory() as temp_dir:
                    runtime_dir = Path(temp_dir)
                    if content:
                        (runtime_dir / "runtime-summary-console-20260529T001418Z.log").write_text(
                            content,
                            encoding="utf-8",
                        )
                    warnings: list[str] = []
                    runtime_rooms = monitor.load_latest_runtime_room_summaries(
                        runtime_dir,
                        [monitor.RoomRef(shard="shardX", room="E26S49")],
                        warnings,
                    )

                if expects_warning:
                    self.assertTrue(any("#cpu-summary" in warning for warning in warnings), warnings)
                else:
                    self.assertEqual(warnings, [])
                runtime_room = runtime_rooms.get("shardX/E26S49")
                if name == "healthy":
                    self.assertIsNotNone(runtime_room)
                    assert runtime_room is not None
                    self.assertEqual(runtime_room[monitor.RUNTIME_SUMMARY_CPU_METADATA_KEY]["bucket"], 9000)
                else:
                    self.assertIsNone(runtime_room)

                emitted, suppressed, _next_state = monitor.evaluate_room_alert(
                    snapshot,
                    {"baseline_established": True, "owner": "owner"},
                    now=100,
                    debounce_seconds=300,
                    runtime_room_summary=runtime_room,
                )

                self.assertEqual(suppressed, [])
                self.assertNotIn(monitor.CPU_BUCKET_CRITICAL_KIND, [reason["kind"] for reason in emitted])
                self.assertNotIn(monitor.CPU_BUCKET_LOW_KIND, [reason["kind"] for reason in emitted])

    def test_compact_cpu_summary_usage_only_and_low_bucket_ticks_are_preserved(self) -> None:
        cases = (
            (
                "used and limit only",
                {"used": 6.5, "limit": 70},
                {"cpuUsed": 6.5, "cpuLimit": 70},
                {"used": 6.5, "limit": 70},
            ),
            (
                "low bucket ticks only",
                {"lowBucketTicks": 4},
                {"lowBucketTicks": 4},
                {"lowBucketTicks": 4},
            ),
        )

        for name, compact_cpu_payload, expected_room_fields, expected_cpu_fields in cases:
            with self.subTest(name=name):
                with tempfile.TemporaryDirectory() as temp_dir:
                    runtime_dir = Path(temp_dir)
                    (runtime_dir / "runtime-summary-console-20260529T001418Z.log").write_text(
                        "#cpu-summary " + json.dumps(compact_cpu_payload) + "\n",
                        encoding="utf-8",
                    )
                    warnings: list[str] = []
                    runtime_rooms = monitor.load_latest_runtime_room_summaries(
                        runtime_dir,
                        [monitor.RoomRef(shard="shardX", room="E26S49")],
                        warnings,
                    )

                self.assertEqual(warnings, [])
                runtime_room = runtime_rooms.get("shardX/E26S49")
                self.assertIsNotNone(runtime_room)
                assert runtime_room is not None
                for field, expected in expected_room_fields.items():
                    self.assertEqual(runtime_room[field], expected)
                cpu_metadata = runtime_room[monitor.RUNTIME_SUMMARY_CPU_METADATA_KEY]
                for field, expected in expected_cpu_fields.items():
                    self.assertEqual(cpu_metadata[field], expected)
                self.assertIsNone(
                    monitor.detect_cpu_bucket_reason(
                        monitor.RoomRef(shard="shardX", room="E26S49"),
                        runtime_room,
                    )
                )

    def test_cpu_bucket_low_runtime_summary_alerts_as_p1(self) -> None:
        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "worker-1": {
                    "type": "creep",
                    "my": True,
                    "owner": {"username": "owner"},
                    "name": "worker-1",
                    "x": 23,
                    "y": 25,
                },
            }
        )
        runtime_room = {
            "roomName": "E26S49",
            monitor.RUNTIME_SUMMARY_CPU_METADATA_KEY: {
                "bucket": 499,
                "pressure": "degraded",
                "alerts": ["lowBucket"],
                "reasons": ["lowBucket"],
            },
        }

        emitted, suppressed, _next_state = monitor.evaluate_room_alert(
            snapshot,
            {"baseline_established": True, "owner": "owner"},
            now=100,
            debounce_seconds=300,
            runtime_room_summary=runtime_room,
        )

        self.assertEqual(suppressed, [])
        self.assertEqual([reason["kind"] for reason in emitted], [monitor.CPU_BUCKET_LOW_KIND])
        self.assertEqual(emitted[0]["priority"], "P1")
        report = monitor.build_tactical_response_report(
            {"ok": True, "mode": "alert", "alert": True, "reasons": emitted, "rooms": ["shardX/E26S49"]}
        )
        self.assertTrue(report["emergency"])
        self.assertEqual(report["severity"], "high")
        self.assertEqual(report["priority"], "P1")
        self.assertEqual(report["categories"], [monitor.CPU_BUCKET_LOW_KIND])

    def test_cpu_bucket_healthy_or_missing_summary_stays_silent(self) -> None:
        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "worker-1": {
                    "type": "creep",
                    "my": True,
                    "owner": {"username": "owner"},
                    "name": "worker-1",
                    "x": 23,
                    "y": 25,
                },
            }
        )
        cases = (
            {"roomName": "E26S49", monitor.RUNTIME_SUMMARY_CPU_METADATA_KEY: {"bucket": 9000, "pressure": "normal"}},
            {"roomName": "E26S49"},
        )

        for runtime_room in cases:
            with self.subTest(runtime_room=runtime_room):
                emitted, suppressed, _next_state = monitor.evaluate_room_alert(
                    snapshot,
                    {"baseline_established": True, "owner": "owner"},
                    now=100,
                    debounce_seconds=300,
                    runtime_room_summary=runtime_room,
                )
                self.assertEqual(suppressed, [])
                self.assertNotIn(monitor.CPU_BUCKET_CRITICAL_KIND, [reason["kind"] for reason in emitted])
                self.assertNotIn(monitor.CPU_BUCKET_LOW_KIND, [reason["kind"] for reason in emitted])

        for room_summary in (
            {
                "room": "shardX/E26S49",
                "owned_creeps": 1,
                "owned_spawns": 1,
                "creeps": 1,
                "spawns": 1,
                "owner": "owner",
                "cpuBucket": 9000,
            },
            {
                "room": "shardX/E26S49",
                "owned_creeps": 1,
                "owned_spawns": 1,
                "creeps": 1,
                "spawns": 1,
                "owner": "owner",
            },
        ):
            with self.subTest(room_summary=room_summary):
                health = monitor.evaluate_postdeploy_health_gate(
                    {"ok": True, "mode": "summary", "room_summaries": [room_summary]},
                    {"ok": True, "mode": "alert", "alert": False, "reasons": []},
                )
                self.assertTrue(health["ok"])

    def test_cpu_bucket_alert_does_not_mask_hostile_or_damage_alerts(self) -> None:
        previous = {
            "baseline_established": True,
            "owner": "owner",
            "structures": {
                "spawn1": {
                    "type": "spawn",
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                    "owned": True,
                    "damageable": True,
                    "critical": True,
                }
            },
        }
        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 4900,
                    "hitsMax": 5000,
                },
                "worker-1": {
                    "type": "creep",
                    "my": True,
                    "owner": {"username": "owner"},
                    "name": "worker-1",
                    "x": 23,
                    "y": 25,
                },
                "hostile-1": {
                    "type": "creep",
                    "owner": {"username": "Invader"},
                    "x": 20,
                    "y": 21,
                },
            }
        )
        runtime_room = {
            "roomName": "E26S49",
            monitor.RUNTIME_SUMMARY_CPU_METADATA_KEY: {
                "bucket": 4,
                "pressure": "critical",
                "alerts": ["lowBucket"],
                "reasons": ["criticalBucket"],
            },
        }

        emitted, suppressed, _next_state = monitor.evaluate_room_alert(
            snapshot,
            previous,
            now=100,
            debounce_seconds=300,
            runtime_room_summary=runtime_room,
        )

        self.assertEqual(suppressed, [])
        self.assertEqual(
            {reason["kind"] for reason in emitted},
            {"hostile_creep", "structure_damage", monitor.CPU_BUCKET_CRITICAL_KIND},
        )

    def test_clean_no_alert_expansion_bootstrap_without_spawn_stays_silent(self) -> None:
        report = monitor.build_tactical_response_report(EXPANSION_BOOTSTRAP_NO_ALERT_FIXTURE)

        self.assertFalse(report["emergency"])
        self.assertTrue(report["silent"])
        self.assertEqual(report["severity"], "none")
        self.assertIsNone(report["priority"])
        self.assertNotIn("spawn_collapse", report["categories"])
        self.assertEqual(report["triggers"], [])
        self.assertEqual(report["source"]["reason_count"], 0)
        self.assertEqual(report["scheduler"]["recommended_output"], "[SILENT]")

    def test_suppressed_room_dead_still_escalates(self) -> None:
        fixture = {
            "ok": True,
            "mode": "alert",
            "alert": False,
            "reasons": [],
            "rooms": ["shardX/E26S49"],
            "suppressed": True,
            "suppressed_count": 1,
            "suppressed_reasons": ROOM_DEAD_ALERT_FIXTURE["reasons"],
        }

        report = monitor.build_tactical_response_report(fixture)

        self.assertTrue(report["emergency"])
        self.assertEqual(report["severity"], "critical")
        self.assertEqual(report["priority"], "P0")
        self.assertTrue(report["scheduler"]["should_post"])
        self.assertTrue(any(trigger["suppressed"] for trigger in report["triggers"]))

    def test_owned_spawns_zero_room_summary_is_critical(self) -> None:
        fixture = {
            "ok": True,
            "mode": "alert",
            "alert": False,
            "reasons": [],
            "rooms": ["shardX/E26S49"],
            "room_summaries": [
                {
                    "room": "shardX/E26S49",
                    "owned_creeps": 2,
                    "owned_spawns": 0,
                    "creeps": 2,
                    "spawns": 0,
                    "owner": "owner",
                }
            ],
        }

        report = monitor.build_tactical_response_report(fixture)

        self.assertTrue(report["emergency"])
        self.assertEqual(report["severity"], "critical")
        self.assertEqual(report["priority"], "P0")
        self.assertIn("spawn_collapse", report["categories"])

    def test_postdeploy_no_owned_spawn_is_critical(self) -> None:
        report = monitor.build_tactical_response_report(
            {
                "ok": True,
                "mode": "health-gate",
                "alert": False,
                "reasons": [
                    {
                        "kind": "postdeploy_no_owned_spawn",
                        "room": "shardX/E26S49",
                        "spawns": 0,
                        "creeps": 0,
                        "message": "shardX/E26S49: no owned spawn recovery path is visible after deploy",
                    }
                ],
            }
        )

        self.assertTrue(report["emergency"])
        self.assertEqual(report["severity"], "critical")
        self.assertEqual(report["priority"], "P0")
        self.assertIn("spawn_collapse", report["categories"])

    def test_generated_critical_owned_structure_damage_is_critical(self) -> None:
        previous = {
            "baseline_established": True,
            "structures": {
                "spawn1": {
                    "type": "spawn",
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                    "owned": True,
                    "damageable": True,
                    "critical": True,
                }
            },
        }
        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 1250,
                    "hitsMax": 5000,
                }
            }
        )
        emitted, _suppressed, _next_state = monitor.evaluate_room_alert(snapshot, previous, now=100, debounce_seconds=300)

        self.assertEqual(emitted[0]["kind"], "structure_damage")
        self.assertEqual(emitted[0]["hitsMax"], 5000)

        report = monitor.build_tactical_response_report(
            {
                "ok": True,
                "mode": "alert",
                "alert": True,
                "reasons": emitted,
                "rooms": ["shardX/E26S49"],
            }
        )

        self.assertTrue(report["emergency"])
        self.assertEqual(report["severity"], "critical")
        self.assertEqual(report["categories"], ["owned_structure_damage"])
        self.assertEqual(report["triggers"][0]["severity"], "critical")

    def test_low_health_non_core_owned_structure_damage_is_critical(self) -> None:
        previous = {
            "baseline_established": True,
            "structures": {
                "factory1": {
                    "type": "factory",
                    "x": 24,
                    "y": 24,
                    "hits": 1000,
                    "hitsMax": 1000,
                    "owned": True,
                    "damageable": True,
                    "critical": True,
                }
            },
        }
        snapshot = make_snapshot(
            {
                "factory1": {
                    "type": "factory",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 24,
                    "y": 24,
                    "hits": 250,
                    "hitsMax": 1000,
                }
            }
        )
        emitted, _suppressed, _next_state = monitor.evaluate_room_alert(snapshot, previous, now=100, debounce_seconds=300)

        damage = next(reason for reason in emitted if reason["kind"] == "structure_damage")
        self.assertEqual(damage["structure_type"], "factory")

        report = monitor.build_tactical_response_report(
            {
                "ok": True,
                "mode": "alert",
                "alert": True,
                "reasons": emitted,
                "rooms": ["shardX/E26S49"],
            }
        )

        self.assertEqual(report["severity"], "critical")
        self.assertIn("owned_structure_damage", report["categories"])
        self.assertEqual(report["triggers"][0]["severity"], "critical")

    def test_expected_safe_rampart_decay_is_suppressed(self) -> None:
        decay = monitor.RAMPART_DECAY_HITS_PER_EVENT
        healthy_hits = monitor.RAMPART_SAFE_DECAY_HITS_FLOOR + 10_000
        healthy_hits_max = 300_000_000
        previous = {
            "baseline_established": True,
            "tick": 1014519,
            "structures": {
                "spawn1": {
                    "type": "spawn",
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                    "owned": True,
                    "damageable": True,
                    "critical": True,
                },
                "rampart1": {
                    "type": "rampart",
                    "x": 8,
                    "y": 24,
                    "hits": healthy_hits + decay,
                    "hitsMax": healthy_hits_max,
                    "owned": True,
                    "damageable": True,
                    "critical": False,
                },
            },
        }
        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "rampart1": {
                    "type": "rampart",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 8,
                    "y": 24,
                    "hits": healthy_hits,
                    "hitsMax": healthy_hits_max,
                },
            },
            tick=1014619,
        )

        self.assertLessEqual(healthy_hits / healthy_hits_max, 0.25)
        emitted, suppressed, next_state = monitor.evaluate_room_alert(
            snapshot,
            previous,
            now=100,
            debounce_seconds=300,
        )

        self.assertEqual(emitted, [])
        self.assertEqual(len(suppressed), 1)
        self.assertEqual(suppressed[0]["suppression_reason"], "expected_rampart_decay")
        self.assertEqual(suppressed[0]["safe_hits_floor"], monitor.RAMPART_SAFE_DECAY_HITS_FLOOR)
        self.assertEqual(suppressed[0]["delta"], decay)
        self.assertEqual(next_state["structures"]["rampart1"]["hits"], healthy_hits)

        report = monitor.build_tactical_response_report(
            {
                "ok": True,
                "mode": "alert",
                "alert": False,
                "reasons": emitted,
                "suppressed": True,
                "suppressed_count": len(suppressed),
                "suppressed_reasons": suppressed,
                "rooms": ["shardX/E26S49"],
            }
        )

        self.assertFalse(report["emergency"])
        self.assertTrue(report["silent"])

    def test_high_health_rampart_decay_after_monitor_gap_is_suppressed(self) -> None:
        previous_tick = 1_613_249
        current_tick = 1_615_205
        current_hits = 2_414_601
        delta = 5_700
        previous = {
            "baseline_established": True,
            "tick": previous_tick,
            "structures": {
                "spawn1": {
                    "type": "spawn",
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                    "owned": True,
                    "damageable": True,
                    "critical": True,
                },
                "rampart1": {
                    "type": "rampart",
                    "x": 35,
                    "y": 27,
                    "hits": current_hits + delta,
                    "hitsMax": 10_000_000,
                    "owned": True,
                    "damageable": True,
                    "critical": False,
                },
            },
        }
        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "rampart1": {
                    "type": "rampart",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 35,
                    "y": 27,
                    "hits": current_hits,
                    "hitsMax": 10_000_000,
                },
            },
            tick=current_tick,
        )

        expected_decay = monitor.expected_rampart_decay_delta(previous, current_tick)
        self.assertGreater(delta, monitor.RAMPART_CRITICAL_DAMAGE_DELTA)
        self.assertGreater(current_hits, monitor.RAMPART_CRITICAL_DAMAGE_HITS_CEILING)
        self.assertLessEqual(delta, expected_decay)

        emitted, suppressed, _next_state = monitor.evaluate_room_alert(
            snapshot,
            previous,
            now=100,
            debounce_seconds=300,
        )

        self.assertEqual(emitted, [])
        self.assertEqual(len(suppressed), 1)
        self.assertEqual(suppressed[0]["delta"], delta)
        self.assertEqual(suppressed[0]["expected_decay_delta"], expected_decay)
        self.assertEqual(suppressed[0]["suppression_reason"], "expected_rampart_decay")

    def test_high_health_rampart_decay_with_one_event_tick_jitter_is_suppressed(self) -> None:
        previous_tick = 1_684_407
        current_tick = 1_684_807
        current_hits = 2_203_221
        delta = 1_500
        previous = {
            "baseline_established": True,
            "tick": previous_tick,
            "visible_hostile_creeps": 0,
            "structures": {
                "spawn1": {
                    "type": "spawn",
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                    "owned": True,
                    "damageable": True,
                    "critical": True,
                },
                "rampart1": {
                    "type": "rampart",
                    "x": 35,
                    "y": 26,
                    "hits": current_hits + delta,
                    "hitsMax": 10_000_000,
                    "owned": True,
                    "damageable": True,
                    "critical": False,
                },
            },
        }
        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "rampart1": {
                    "type": "rampart",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 35,
                    "y": 26,
                    "hits": current_hits,
                    "hitsMax": 10_000_000,
                },
            },
            tick=current_tick,
        )

        expected_decay = monitor.expected_rampart_decay_delta(previous, current_tick)
        allowed_decay = monitor.safe_rampart_decay_suppression_delta(previous, current_tick)
        self.assertEqual(expected_decay, 1_200)
        self.assertEqual(delta, expected_decay + monitor.RAMPART_DECAY_HITS_PER_EVENT)
        self.assertEqual(allowed_decay, delta)
        self.assertGreater(current_hits, monitor.RAMPART_CRITICAL_DAMAGE_HITS_CEILING)

        emitted, suppressed, _next_state = monitor.evaluate_room_alert(
            snapshot,
            previous,
            now=100,
            debounce_seconds=300,
        )

        self.assertEqual(emitted, [])
        self.assertEqual(len(suppressed), 1)
        self.assertEqual(suppressed[0]["delta"], delta)
        self.assertEqual(suppressed[0]["expected_decay_delta"], expected_decay)
        self.assertEqual(suppressed[0]["allowed_decay_delta"], allowed_decay)
        self.assertEqual(suppressed[0]["suppression_reason"], "expected_rampart_decay")

    def test_unknown_or_non_advancing_rampart_decay_ticks_do_not_suppress_damage(self) -> None:
        decay = monitor.RAMPART_DECAY_HITS_PER_EVENT
        safe_floor = monitor.RAMPART_SAFE_DECAY_HITS_FLOOR
        healthy_hits = safe_floor + 1
        cases = (
            ("missing_previous_tick", {}, 1014619),
            ("missing_current_tick", {"tick": 1014519}, None),
            ("regressed_current_tick", {"tick": 1014619}, 1014519),
            ("unchanged_current_tick", {"tick": 1014519}, 1014519),
        )

        for name, tick_fields, current_tick in cases:
            with self.subTest(name=name):
                previous = {
                    "baseline_established": True,
                    **tick_fields,
                    "structures": {
                        "spawn1": {
                            "type": "spawn",
                            "x": 25,
                            "y": 25,
                            "hits": 5000,
                            "hitsMax": 5000,
                            "owned": True,
                            "damageable": True,
                            "critical": True,
                        },
                        "rampart1": {
                            "type": "rampart",
                            "x": 8,
                            "y": 24,
                            "hits": healthy_hits + decay,
                            "hitsMax": 300000,
                            "owned": True,
                            "damageable": True,
                            "critical": False,
                        },
                    },
                }
                snapshot = make_snapshot(
                    {
                        "spawn1": {
                            "type": "spawn",
                            "my": True,
                            "owner": {"username": "owner"},
                            "x": 25,
                            "y": 25,
                            "hits": 5000,
                            "hitsMax": 5000,
                        },
                        "rampart1": {
                            "type": "rampart",
                            "my": True,
                            "owner": {"username": "owner"},
                            "x": 8,
                            "y": 24,
                            "hits": healthy_hits,
                            "hitsMax": 300000,
                        },
                    },
                    tick=current_tick,
                )

                self.assertEqual(monitor.expected_rampart_decay_delta(previous, current_tick), 0)
                emitted, suppressed, _next_state = monitor.evaluate_room_alert(
                    snapshot,
                    previous,
                    now=100,
                    debounce_seconds=300,
                )

                self.assertEqual(suppressed, [])
                self.assertEqual([reason["kind"] for reason in emitted], ["structure_damage"])
                self.assertEqual(emitted[0]["structure_type"], "rampart")

    def test_low_relative_health_rampart_damage_is_not_critical_from_percentage(self) -> None:
        decay = monitor.RAMPART_DECAY_HITS_PER_EVENT
        current_hits = 20_000
        hits_max = 300_000_000
        reason = {
            "kind": "structure_damage",
            "room": "shardX/E26S49",
            "object_id": "rampart1",
            "structure_type": "rampart",
            "x": 8,
            "y": 24,
            "current_hits": current_hits,
            "hitsMax": hits_max,
            "delta": decay,
            "message": "rampart hits decreased 20300->20000 at 8,24",
        }

        self.assertGreater(current_hits, monitor.RAMPART_SAFE_DECAY_HITS_FLOOR)
        self.assertLessEqual(current_hits / hits_max, 0.25)
        self.assertLess(decay, monitor.RAMPART_CRITICAL_DAMAGE_DELTA)
        self.assertEqual(monitor.category_severity("owned_structure_damage", reason), "high")

        report = monitor.build_tactical_response_report(
            {
                "ok": True,
                "mode": "alert",
                "alert": True,
                "reasons": [reason],
                "rooms": ["shardX/E26S49"],
            }
        )

        self.assertTrue(report["emergency"])
        self.assertEqual(report["severity"], "high")
        self.assertEqual(report["priority"], "P1")
        self.assertEqual(report["triggers"][0]["severity"], "high")
        self.assertEqual(report["triggers"][0]["priority"], "P1")

    def test_high_health_large_rampart_drop_stays_p1(self) -> None:
        reason = {
            "kind": "structure_damage",
            "room": "shardX/E29N55",
            "object_id": "6a09deb5b2438b0a399c3f8e",
            "structure_type": "rampart",
            "x": 35,
            "y": 29,
            "previous_hits": 2_534_911,
            "current_hits": 2_493_091,
            "hitsMax": 3_000_000,
            "delta": 41_820,
            "message": "rampart hits decreased 2534911->2493091 at 35,29",
        }

        self.assertGreater(reason["current_hits"], monitor.RAMPART_CRITICAL_DAMAGE_HITS_CEILING)
        self.assertEqual(monitor.category_severity("owned_structure_damage", reason), "high")

        report = monitor.build_tactical_response_report(
            {
                "ok": True,
                "mode": "alert",
                "alert": True,
                "reasons": [reason],
                "rooms": ["shardX/E29N55"],
            }
        )

        self.assertTrue(report["emergency"])
        self.assertEqual(report["severity"], "high")
        self.assertEqual(report["priority"], "P1")
        self.assertEqual(report["triggers"][0]["severity"], "high")
        self.assertEqual(report["triggers"][0]["priority"], "P1")

    def test_exact_safe_floor_rampart_decay_still_alerts_p0(self) -> None:
        decay = monitor.RAMPART_DECAY_HITS_PER_EVENT
        safe_floor = monitor.RAMPART_SAFE_DECAY_HITS_FLOOR
        previous = {
            "baseline_established": True,
            "tick": 2000,
            "structures": {
                "spawn1": {
                    "type": "spawn",
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                    "owned": True,
                    "damageable": True,
                    "critical": True,
                },
                "rampart1": {
                    "type": "rampart",
                    "x": 8,
                    "y": 24,
                    "hits": safe_floor + decay,
                    "hitsMax": 300000,
                    "owned": True,
                    "damageable": True,
                    "critical": False,
                },
            },
        }
        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "rampart1": {
                    "type": "rampart",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 8,
                    "y": 24,
                    "hits": safe_floor,
                    "hitsMax": 300000,
                },
            },
            tick=2100,
        )

        emitted, suppressed, _next_state = monitor.evaluate_room_alert(
            snapshot,
            previous,
            now=100,
            debounce_seconds=300,
        )

        self.assertEqual(suppressed, [])
        self.assertEqual([reason["kind"] for reason in emitted], ["structure_damage"])

        report = monitor.build_tactical_response_report(
            {
                "ok": True,
                "mode": "alert",
                "alert": True,
                "reasons": emitted,
                "rooms": ["shardX/E26S49"],
            }
        )

        self.assertTrue(report["emergency"])
        self.assertEqual(report["severity"], "critical")
        self.assertEqual(report["priority"], "P0")

    def test_large_rampart_drop_still_alerts_p0(self) -> None:
        decay = monitor.RAMPART_DECAY_HITS_PER_EVENT
        safe_floor = monitor.RAMPART_SAFE_DECAY_HITS_FLOOR
        current_hits = safe_floor + decay * 10
        large_delta = monitor.RAMPART_CRITICAL_DAMAGE_DELTA + decay
        previous_tick = 3000
        current_tick = previous_tick + monitor.RAMPART_DECAY_EVENT_TICKS * 18
        previous = {
            "baseline_established": True,
            "tick": previous_tick,
            "structures": {
                "spawn1": {
                    "type": "spawn",
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                    "owned": True,
                    "damageable": True,
                    "critical": True,
                },
                "rampart1": {
                    "type": "rampart",
                    "x": 8,
                    "y": 24,
                    "hits": current_hits + large_delta,
                    "hitsMax": 300000,
                    "owned": True,
                    "damageable": True,
                    "critical": False,
                },
            },
        }
        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "rampart1": {
                    "type": "rampart",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 8,
                    "y": 24,
                    "hits": current_hits,
                    "hitsMax": 300000,
                },
            },
            tick=current_tick,
        )
        self.assertGreaterEqual(monitor.expected_rampart_decay_delta(previous, current_tick), large_delta)
        self.assertLessEqual(current_hits, monitor.RAMPART_CRITICAL_DAMAGE_HITS_CEILING)

        emitted, suppressed, _next_state = monitor.evaluate_room_alert(
            snapshot,
            previous,
            now=100,
            debounce_seconds=300,
        )

        self.assertEqual(suppressed, [])
        self.assertEqual(emitted[0]["delta"], large_delta)

        report = monitor.build_tactical_response_report(
            {
                "ok": True,
                "mode": "alert",
                "alert": True,
                "reasons": emitted,
                "rooms": ["shardX/E26S49"],
            }
        )

        self.assertTrue(report["emergency"])
        self.assertEqual(report["severity"], "critical")
        self.assertEqual(report["priority"], "P0")

    def test_visible_hostile_keeps_rampart_damage_alertable(self) -> None:
        decay = monitor.RAMPART_DECAY_HITS_PER_EVENT
        safe_floor = monitor.RAMPART_SAFE_DECAY_HITS_FLOOR
        healthy_hits = safe_floor + 1
        previous = {
            "baseline_established": True,
            "tick": 4000,
            "structures": {
                "spawn1": {
                    "type": "spawn",
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                    "owned": True,
                    "damageable": True,
                    "critical": True,
                },
                "rampart1": {
                    "type": "rampart",
                    "x": 8,
                    "y": 24,
                    "hits": healthy_hits + decay,
                    "hitsMax": 300000,
                    "owned": True,
                    "damageable": True,
                    "critical": False,
                },
            },
        }
        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "rampart1": {
                    "type": "rampart",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 8,
                    "y": 24,
                    "hits": healthy_hits,
                    "hitsMax": 300000,
                },
                "hostile1": {
                    "type": "creep",
                    "owner": {"username": "Invader"},
                    "x": 9,
                    "y": 24,
                },
            },
            tick=4100,
        )

        emitted, suppressed, _next_state = monitor.evaluate_room_alert(
            snapshot,
            previous,
            now=100,
            debounce_seconds=300,
        )

        self.assertEqual(suppressed, [])
        self.assertCountEqual([reason["kind"] for reason in emitted], ["hostile_creep", "structure_damage"])

    def test_recent_hostile_keeps_rampart_damage_alertable_after_leaving(self) -> None:
        decay = monitor.RAMPART_DECAY_HITS_PER_EVENT
        safe_floor = monitor.RAMPART_SAFE_DECAY_HITS_FLOOR
        healthy_hits = safe_floor + 1
        previous_tick = 5000
        previous = {
            "baseline_established": True,
            "tick": previous_tick,
            "visible_hostile_creeps": 1,
            "last_visible_hostile_tick": previous_tick,
            "structures": {
                "spawn1": {
                    "type": "spawn",
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                    "owned": True,
                    "damageable": True,
                    "critical": True,
                },
                "rampart1": {
                    "type": "rampart",
                    "x": 8,
                    "y": 24,
                    "hits": healthy_hits + decay,
                    "hitsMax": 300000,
                    "owned": True,
                    "damageable": True,
                    "critical": False,
                },
            },
        }
        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "rampart1": {
                    "type": "rampart",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 8,
                    "y": 24,
                    "hits": healthy_hits,
                    "hitsMax": 300000,
                },
            },
            tick=previous_tick + monitor.RAMPART_DECAY_EVENT_TICKS,
        )

        emitted, suppressed, _next_state = monitor.evaluate_room_alert(
            snapshot,
            previous,
            now=100,
            debounce_seconds=300,
        )

        self.assertEqual(suppressed, [])
        self.assertEqual([reason["kind"] for reason in emitted], ["structure_damage"])

    def test_previous_visible_hostile_keeps_rampart_damage_alertable_beyond_recent_window(self) -> None:
        decay = monitor.RAMPART_DECAY_HITS_PER_EVENT
        safe_floor = monitor.RAMPART_SAFE_DECAY_HITS_FLOOR
        healthy_hits = safe_floor + 1
        previous_tick = 6000
        current_tick = previous_tick + monitor.RAMPART_DECAY_RECENT_HOSTILE_TICKS + 1
        previous = {
            "baseline_established": True,
            "tick": previous_tick,
            "visible_hostile_creeps": 1,
            "last_visible_hostile_tick": previous_tick,
            "structures": {
                "spawn1": {
                    "type": "spawn",
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                    "owned": True,
                    "damageable": True,
                    "critical": True,
                },
                "rampart1": {
                    "type": "rampart",
                    "x": 8,
                    "y": 24,
                    "hits": healthy_hits + decay,
                    "hitsMax": 300000,
                    "owned": True,
                    "damageable": True,
                    "critical": False,
                },
            },
        }
        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "rampart1": {
                    "type": "rampart",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 8,
                    "y": 24,
                    "hits": healthy_hits,
                    "hitsMax": 300000,
                },
            },
            tick=current_tick,
        )

        self.assertGreater(current_tick - previous_tick, monitor.RAMPART_DECAY_RECENT_HOSTILE_TICKS)
        emitted, suppressed, _next_state = monitor.evaluate_room_alert(
            snapshot,
            previous,
            now=100,
            debounce_seconds=300,
        )

        self.assertEqual(suppressed, [])
        self.assertEqual([reason["kind"] for reason in emitted], ["structure_damage"])
        self.assertEqual(emitted[0]["structure_type"], "rampart")
        self.assertEqual(emitted[0]["delta"], decay)

    def test_report_is_json_serializable(self) -> None:
        rendered = json.dumps(monitor.build_tactical_response_report(HOSTILE_ALERT_FIXTURE), sort_keys=True)

        self.assertIn('"mode": "tactical-response"', rendered)
        self.assertIn('"severity": "high"', rendered)

    def test_clean_private_smoke_report_stays_silent(self) -> None:
        report = monitor.build_tactical_response_report(clean_private_smoke_fixture())

        self.assertFalse(report["emergency"])
        self.assertTrue(report["silent"])
        self.assertEqual(report["severity"], "none")
        self.assertEqual(report["categories"], [])
        self.assertEqual(report["source"]["mode"], "private-smoke")
        self.assertEqual(report["source"]["rooms"], ["shardX/E1S1"])
        self.assertEqual(report["source"]["failed_phase_count"], 0)
        self.assertEqual(report["scheduler"]["recommended_output"], "[SILENT]")

    def test_private_smoke_min_creeps_zero_stays_silent_with_zero_creeps(self) -> None:
        fixture = copy.deepcopy(clean_private_smoke_fixture())
        for phase in fixture["phases"]:
            if phase["name"] == "poll-stats":
                phase["details"]["criteria"]["min_creeps"] = 0
                phase["details"]["last"]["user"]["creeps"] = 0
                break

        report = monitor.build_tactical_response_report(fixture)

        self.assertFalse(report["emergency"])
        self.assertTrue(report["silent"])
        self.assertEqual(report["categories"], [])

    def test_message_based_tactical_category_inference_has_message_scope(self) -> None:
        categories = monitor.infer_tactical_categories(
            {
                "kind": "custom_alert",
                "message": "private smoke no-progress deadlock detected",
            }
        )

        self.assertIn("runtime_deadlock", categories)
        self.assertIn("private_smoke_failure", categories)

    def test_private_smoke_poll_stats_without_samples_is_telemetry_silence(self) -> None:
        fixture = copy.deepcopy(clean_private_smoke_fixture())
        fixture["ok"] = False
        for phase in fixture["phases"]:
            if phase["name"] == "poll-stats":
                phase["ok"] = False
                phase["details"] = {
                    "ok": False,
                    "samples": 0,
                    "first": None,
                    "last": None,
                    "criteria": {"min_creeps": 1},
                    "error": "stats criteria were not met before timeout",
                }
                break

        report = monitor.build_tactical_response_report(fixture)

        self.assertTrue(report["emergency"])
        self.assertEqual(report["severity"], "critical")
        self.assertEqual(report["categories"], ["telemetry_silence", "private_smoke_failure"])
        self.assertEqual(report["triggers"][0]["reason_kind"], "private_smoke_telemetry_silence")
        self.assertEqual(report["triggers"][0]["decision"], "rollback_or_monitor_fix")
        self.assertIn("inspect_recent_deploy", {action["id"] for action in report["next_actions"]})

    def test_private_smoke_missing_spawn_evidence_is_spawn_collapse(self) -> None:
        fixture = copy.deepcopy(clean_private_smoke_fixture())
        for phase in fixture["phases"]:
            if phase["name"] == "mongo-summary":
                phase["details"]["summary"]["counts"]["spawn"] = 0
                phase["details"]["summary"]["spawns"] = []
                break

        report = monitor.build_tactical_response_report(fixture)

        self.assertTrue(report["emergency"])
        self.assertEqual(report["severity"], "critical")
        self.assertEqual(report["categories"], ["spawn_collapse", "private_smoke_failure"])
        self.assertEqual(report["triggers"][0]["reason_kind"], "private_smoke_spawn_collapse")
        self.assertEqual(report["triggers"][0]["structure_type"], "spawn")


class RuntimeKpiArtifactTests(unittest.TestCase):
    def test_runtime_summary_payload_uses_live_room_snapshot_metrics(self) -> None:
        snapshot = monitor.RoomSnapshot(
            ref=monitor.RoomRef(shard="shardX", room="E26S49"),
            terrain="0" * monitor.TERRAIN_CELLS,
            objects={
                "controller-1": {
                    "_id": "controller-1",
                    "type": "controller",
                    "my": True,
                    "owner": {"username": "lanyusea"},
                    "level": 3,
                    "progress": 1250,
                    "progressTotal": 45000,
                    "ticksToDowngrade": 19876,
                    "sign": {
                        "username": "lanyusea",
                        "text": "by Hermes Screeps Project",
                        "time": 265600,
                        "datetime": "2026-05-15T00:00:00.000Z",
                    },
                    "x": 24,
                    "y": 24,
                },
                "spawn-1": {
                    "_id": "spawn-1",
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "lanyusea"},
                    "store": {"energy": 265},
                    "x": 25,
                    "y": 23,
                },
                "extension-1": {
                    "_id": "extension-1",
                    "type": "extension",
                    "my": True,
                    "owner": {"username": "lanyusea"},
                    "store": {"energy": 50},
                    "x": 26,
                    "y": 23,
                },
                "container-1": {
                    "_id": "container-1",
                    "type": "container",
                    "store": {"energy": 40},
                    "x": 26,
                    "y": 24,
                },
                "worker-1": {
                    "_id": "worker-1",
                    "type": "creep",
                    "my": True,
                    "owner": {"username": "lanyusea"},
                    "carry": {"energy": 61},
                    "memory": {"role": "worker", "task": "build"},
                    "x": 27,
                    "y": 23,
                },
                "defender-1": {
                    "_id": "defender-1",
                    "type": "creep",
                    "my": True,
                    "owner": {"username": "lanyusea"},
                    "body": [{"type": "attack"}, {"type": "move"}],
                    "memory": {"role": "defender"},
                    "x": 25,
                    "y": 23,
                },
                "scout-1": {
                    "_id": "scout-1",
                    "type": "creep",
                    "my": True,
                    "owner": {"username": "lanyusea"},
                    "body": [{"type": "move"}],
                    "memory": {"role": "scout"},
                    "x": 25,
                    "y": 22,
                },
                "claimer-1": {
                    "_id": "claimer-1",
                    "type": "creep",
                    "my": True,
                    "owner": {"username": "lanyusea"},
                    "body": [{"type": "claim"}, {"type": "move"}],
                    "memory": {"role": "claimer"},
                    "x": 25,
                    "y": 21,
                },
                "site-1": {
                    "_id": "site-1",
                    "type": "constructionSite",
                    "my": True,
                    "owner": {"username": "lanyusea"},
                    "structureType": "extension",
                    "progress": 75,
                    "progressTotal": 200,
                    "x": 27,
                    "y": 24,
                },
                "source-1": {"_id": "source-1", "type": "source", "energy": 2846, "x": 20, "y": 20},
                "hostile-1": {
                    "_id": "hostile-1",
                    "type": "creep",
                    "my": False,
                    "owner": {"username": "Invader"},
                    "x": 10,
                    "y": 10,
                },
            },
            tick=265630,
            owner="lanyusea",
            info={"cpu": {"used": 7.25, "bucket": 9123}},
        )

        payload = monitor.runtime_summary_payload_from_snapshots([snapshot])

        self.assertEqual(payload["type"], "runtime-summary")
        self.assertEqual(payload["tick"], 265630)
        self.assertEqual(payload["rooms"][0]["roomName"], "E26S49")
        self.assertEqual(payload["rooms"][0]["controller"]["level"], 3)
        self.assertEqual(payload["rooms"][0]["controller"]["progress"], 1250)
        self.assertEqual(
            payload["rooms"][0]["controller"]["sign"],
            {
                "username": "lanyusea",
                "text": "by Hermes Screeps Project",
                "time": 265600,
                "datetime": "2026-05-15T00:00:00.000Z",
            },
        )
        self.assertEqual(payload["rooms"][0]["rclLevel"], 3)
        self.assertEqual(payload["rooms"][0]["storedEnergy"], 355)
        self.assertEqual(payload["rooms"][0]["workerCarriedEnergy"], 61)
        self.assertEqual(payload["rooms"][0]["resources"]["storedEnergy"], 355)
        self.assertEqual(payload["rooms"][0]["resources"]["workerCarriedEnergy"], 61)
        self.assertEqual(payload["rooms"][0]["resources"]["sourceCount"], 1)
        self.assertEqual(payload["rooms"][0]["taskCounts"]["build"], 1)
        self.assertEqual(payload["rooms"][0]["pendingBuildProgress"], 125)
        self.assertEqual(payload["rooms"][0]["buildCarriedEnergy"], 61)
        self.assertEqual(payload["rooms"][0]["constructionDeadlockTicks"], 0)
        self.assertEqual(payload["rooms"][0]["constructionSiteCount"], 1)
        self.assertEqual(payload["rooms"][0]["extensionCount"], 1)
        self.assertEqual(payload["rooms"][0]["extensionCapacityContribution"], 50)
        self.assertEqual(payload["rooms"][0]["structures"]["extensionCount"], 1)
        self.assertEqual(payload["rooms"][0]["resources"]["productiveEnergy"]["pendingBuildProgress"], 125)
        self.assertEqual(payload["rooms"][0]["resources"]["productiveEnergy"]["buildCarriedEnergy"], 61)
        self.assertEqual(payload["rooms"][0]["resources"]["productiveEnergy"]["constructionDeadlockTicks"], 0)
        self.assertEqual(payload["rooms"][0]["resources"]["productiveEnergy"]["constructionSiteCount"], 1)
        self.assertNotIn("buildBlockedReason", payload["rooms"][0]["resources"]["productiveEnergy"])
        self.assertNotIn("behavior", payload["rooms"][0])
        self.assertNotIn("pathFindingFailures", payload["rooms"][0])
        self.assertNotIn("destinationBlocked", payload["rooms"][0])
        self.assertEqual(
            payload["rooms"][0]["workerLoadEfficiency"],
            {"sampleCount": 1, "tripEnergyMean": 61.0, "tripEnergyMin": 61},
        )
        self.assertEqual(payload["rooms"][0]["cpuUsed"], 7.25)
        self.assertEqual(payload["rooms"][0]["cpuBucket"], 9123)
        self.assertEqual(payload["cpu"], {"used": 7.25, "bucket": 9123})
        self.assertEqual(payload["rooms"][0]["combat"]["hostileCreepCount"], 1)

    def test_runtime_summary_payload_reports_null_controller_sign_evidence(self) -> None:
        snapshot = monitor.RoomSnapshot(
            ref=monitor.RoomRef(shard="shardX", room="E26S49"),
            terrain="0" * monitor.TERRAIN_CELLS,
            objects={
                "controller-1": {
                    "_id": "controller-1",
                    "type": "controller",
                    "my": True,
                    "owner": {"username": "lanyusea"},
                    "level": 3,
                }
            },
            tick=265631,
            owner="lanyusea",
            info={},
        )

        payload = monitor.runtime_summary_payload_from_snapshots([snapshot])
        summary = monitor.room_summary(snapshot)

        self.assertIsNone(payload["rooms"][0]["controller"]["sign"])
        self.assertIsNone(summary["controller"]["sign"])

    def test_runtime_summary_artifact_line_is_bridge_compatible(self) -> None:
        snapshot = monitor.RoomSnapshot(
            ref=monitor.RoomRef(shard="shardX", room="E26S49"),
            terrain="0" * monitor.TERRAIN_CELLS,
            objects={},
            tick=265631,
            owner="lanyusea",
            info={},
        )

        line = monitor.runtime_summary_artifact_line([snapshot])

        self.assertTrue(line.startswith("#runtime-summary "))
        self.assertTrue(line.endswith("\n"))
        payload = json.loads(line.split(" ", 1)[1])
        self.assertEqual(payload["tick"], 265631)
        self.assertEqual(payload["rooms"][0]["roomName"], "E26S49")

    def test_runtime_summary_preserves_explicit_pathing_totals(self) -> None:
        snapshot = monitor.RoomSnapshot(
            ref=monitor.RoomRef(shard="shardX", room="E26S49"),
            terrain="0" * monitor.TERRAIN_CELLS,
            objects={},
            tick=265631,
            owner="lanyusea",
            info={"behavior": {"totals": {"pathFindingFailures": 2, "destinationBlocked": 0}}},
        )

        payload = monitor.runtime_summary_payload_from_snapshots([snapshot])
        summary = monitor.room_summary(snapshot)

        expected = {"pathFindingFailures": 2, "destinationBlocked": 0}
        self.assertEqual(payload["rooms"][0]["behavior"]["totals"], expected)
        self.assertEqual(summary["behavior"]["totals"], expected)

    def test_runtime_summary_payload_classifies_unassigned_build_backlog(self) -> None:
        snapshot = monitor.RoomSnapshot(
            ref=monitor.RoomRef(shard="shardX", room="E26S49"),
            terrain="0" * monitor.TERRAIN_CELLS,
            objects=monitor.normalize_objects(
                {
                    "site-1": {
                        "_id": "site-1",
                        "type": "constructionSite",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "structureType": "extension",
                        "progress": 0,
                        "progressTotal": 50,
                    },
                    "worker-1": {
                        "_id": "worker-1",
                        "type": "creep",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "name": "worker-E26S49-1",
                        "body": [
                            {"type": "work", "hits": 100},
                            {"type": "carry", "hits": 100},
                        ],
                        "store": {"energy": 0, "capacity": 50},
                        "memory": {"role": "worker"},
                    },
                }
            ),
            tick=265632,
            owner="lanyusea",
            info={"energyAvailable": 300},
        )

        payload = monitor.runtime_summary_payload_from_snapshots([snapshot])

        self.assertEqual(payload["rooms"][0]["buildBlockedReason"], "worker_assignment_gap")
        self.assertEqual(payload["rooms"][0]["constructionDeadlockTicks"], 1)
        self.assertEqual(
            payload["rooms"][0]["resources"]["productiveEnergy"]["buildBlockedReason"],
            "worker_assignment_gap",
        )
        self.assertEqual(payload["rooms"][0]["resources"]["productiveEnergy"]["constructionDeadlockTicks"], 1)

    def test_runtime_summary_payload_keeps_zero_owned_creeps_assignment_evidence_free(self) -> None:
        snapshot = monitor.RoomSnapshot(
            ref=monitor.RoomRef(shard="shardX", room="E29N55"),
            terrain="0" * monitor.TERRAIN_CELLS,
            objects=monitor.normalize_objects(
                {
                    "spawn-1": {
                        "_id": "spawn-1",
                        "type": "spawn",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "name": "Spawn1",
                        "hits": 5000,
                        "hitsMax": 5000,
                    },
                    "site-1": {
                        "_id": "site-1",
                        "type": "constructionSite",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "structureType": "extension",
                        "progress": 0,
                        "progressTotal": 50,
                    },
                }
            ),
            tick=999274,
            owner="lanyusea",
            info={"energyAvailable": 300},
        )

        payload = monitor.runtime_summary_payload_from_snapshots([snapshot])
        room = payload["rooms"][0]
        productive_energy = room["resources"]["productiveEnergy"]
        summary = monitor.room_summary(snapshot)

        self.assertEqual(summary["owned_spawns"], 1)
        self.assertEqual(summary["owned_creeps"], 0)
        self.assertFalse(room["workerAssignmentEvidenceAvailable"])
        self.assertFalse(productive_energy["workerAssignmentEvidenceAvailable"])
        self.assertNotIn("buildBlockedReason", room)
        self.assertNotIn("buildBlockedReason", productive_energy)
        self.assertEqual(room["constructionDeadlockTicks"], 0)
        self.assertEqual(productive_energy["constructionDeadlockTicks"], 0)

        reason, next_state = monitor.detect_worker_assignment_gap_sustained_reason(
            snapshot.ref,
            None,
            monitor.compute_room_summary_metrics(snapshot),
            {"start_tick": 999100, "last_tick": 999200, "consecutive_ticks": 100},
            snapshot.tick,
        )

        self.assertIsNone(reason)
        self.assertEqual(next_state, 0)

    def test_zero_owned_creeps_without_spawn_still_routes_to_room_dead(self) -> None:
        snapshot = monitor.RoomSnapshot(
            ref=monitor.RoomRef(shard="shardX", room="E29N55"),
            terrain="0" * monitor.TERRAIN_CELLS,
            objects=monitor.normalize_objects(
                {
                    "site-1": {
                        "_id": "site-1",
                        "type": "constructionSite",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "structureType": "extension",
                        "progress": 0,
                        "progressTotal": 50,
                    },
                }
            ),
            tick=999274,
            owner="lanyusea",
            info={"energyAvailable": 300},
            expected_owner="lanyusea",
        )

        emitted, suppressed, _next_state = monitor.evaluate_room_alert(
            snapshot,
            {"baseline_established": True, "owner": "lanyusea"},
            now=100,
            debounce_seconds=300,
        )
        report = monitor.build_tactical_response_report({"ok": True, "mode": "alert", "alert": True, "reasons": emitted})

        self.assertEqual(suppressed, [])
        self.assertIn("room_dead", [reason["kind"] for reason in emitted])
        self.assertNotIn(monitor.WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND, [reason["kind"] for reason in emitted])
        self.assertIn("room_dead", report["categories"])
        self.assertIn("spawn_collapse", report["categories"])

    def test_runtime_summary_payload_does_not_classify_worker_gap_without_assignment_evidence(self) -> None:
        snapshot = monitor.RoomSnapshot(
            ref=monitor.RoomRef(shard="shardX", room="E29N55"),
            terrain="0" * monitor.TERRAIN_CELLS,
            objects=monitor.normalize_objects(
                {
                    "site-1": {
                        "_id": "site-1",
                        "type": "constructionSite",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "structureType": "extension",
                        "progress": 0,
                        "progressTotal": 50,
                    },
                    "creep-1": {
                        "_id": "creep-1",
                        "type": "creep",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "name": "worker-E29N55-1",
                        "store": {"energy": 12, "capacity": 50},
                    },
                    "creep-2": {
                        "_id": "creep-2",
                        "type": "creep",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "name": "worker-E29N55-2",
                        "store": {"energy": 36, "capacity": 50},
                    },
                }
            ),
            tick=999271,
            owner="lanyusea",
            info={"energyAvailable": 333},
        )

        payload = monitor.runtime_summary_payload_from_snapshots([snapshot])
        room = payload["rooms"][0]
        productive_energy = room["resources"]["productiveEnergy"]

        self.assertFalse(room["workerAssignmentEvidenceAvailable"])
        self.assertFalse(productive_energy["workerAssignmentEvidenceAvailable"])
        self.assertEqual(
            room["taskCounts"],
            {"harvest": 0, "transfer": 0, "build": 0, "repair": 0, "upgrade": 0, "none": 0},
        )
        self.assertEqual(room["workerCarriedEnergy"], 48)
        self.assertEqual(room["resources"]["workerCarriedEnergy"], 48)
        self.assertEqual(room["constructionDeadlockTicks"], 0)
        self.assertNotIn("buildBlockedReason", room)
        self.assertNotIn("buildBlockedReason", productive_energy)
        reason, next_state = monitor.detect_worker_assignment_gap_sustained_reason(
            snapshot.ref,
            None,
            monitor.compute_room_summary_metrics(snapshot),
            {"start_tick": 999100, "last_tick": 999200, "consecutive_ticks": 100},
            snapshot.tick,
        )
        self.assertIsNone(reason)
        self.assertEqual(next_state, 0)

    def test_runtime_summary_payload_ignores_non_worker_assignment_evidence(self) -> None:
        snapshot = monitor.RoomSnapshot(
            ref=monitor.RoomRef(shard="shardX", room="E29N55"),
            terrain="0" * monitor.TERRAIN_CELLS,
            objects=monitor.normalize_objects(
                {
                    "site-1": {
                        "_id": "site-1",
                        "type": "constructionSite",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "structureType": "extension",
                        "progress": 0,
                        "progressTotal": 50,
                    },
                    "claimer-1": {
                        "_id": "claimer-1",
                        "type": "creep",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "name": "claimer-E29N55-1",
                        "memory": {"role": "claimer", "task": {"type": "claim", "targetId": "controller1"}},
                        "store": {"energy": 0, "capacity": 0},
                    },
                }
            ),
            tick=999272,
            owner="lanyusea",
            info={"energyAvailable": 333},
        )

        payload = monitor.runtime_summary_payload_from_snapshots([snapshot])
        room = payload["rooms"][0]
        productive_energy = room["resources"]["productiveEnergy"]

        self.assertFalse(room["workerAssignmentEvidenceAvailable"])
        self.assertFalse(productive_energy["workerAssignmentEvidenceAvailable"])
        self.assertEqual(
            room["taskCounts"],
            {"harvest": 0, "transfer": 0, "build": 0, "repair": 0, "upgrade": 0, "none": 0},
        )
        self.assertEqual(room["constructionDeadlockTicks"], 0)
        self.assertNotIn("buildBlockedReason", room)
        self.assertNotIn("buildBlockedReason", productive_energy)

    def test_runtime_summary_payload_uses_explicit_blocked_worker_telemetry_as_assignment_evidence(self) -> None:
        explicit_workers = [
            {
                "name": "WorkerA",
                "task": "upgrade",
                "carriedEnergy": 50,
                "freeCapacity": 0,
                "buildBlockedReason": "build_blocked_controller_progress_preferred",
                "repairBlockedReason": "repair_blocked_build_backlog_first",
            }
        ]
        snapshot = monitor.RoomSnapshot(
            ref=monitor.RoomRef(shard="shardX", room="E29N55"),
            terrain="0" * monitor.TERRAIN_CELLS,
            objects=monitor.normalize_objects(
                {
                    "site-1": {
                        "_id": "site-1",
                        "type": "constructionSite",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "structureType": "extension",
                        "progress": 0,
                        "progressTotal": 50,
                    }
                }
            ),
            tick=999273,
            owner="lanyusea",
            info={
                "energyAvailable": 333,
                "resources": {
                    "productiveEnergy": {
                        "workerAssignmentBlockedDetail": "spawn_reserving_energy",
                        "workerAssignmentBlockedWorkers": explicit_workers,
                    }
                },
            },
        )

        payload = monitor.runtime_summary_payload_from_snapshots([snapshot])
        room = payload["rooms"][0]
        productive_energy = room["resources"]["productiveEnergy"]

        self.assertTrue(room["workerAssignmentEvidenceAvailable"])
        self.assertTrue(productive_energy["workerAssignmentEvidenceAvailable"])
        self.assertEqual(room["buildBlockedReason"], monitor.WORKER_ASSIGNMENT_GAP_BLOCKED_REASON)
        self.assertEqual(productive_energy["buildBlockedReason"], monitor.WORKER_ASSIGNMENT_GAP_BLOCKED_REASON)
        self.assertEqual(room["constructionDeadlockTicks"], 1)
        self.assertEqual(productive_energy["constructionDeadlockTicks"], 1)
        self.assertEqual(room["workerAssignmentBlockedDetail"], "spawn_reserving_energy")
        self.assertEqual(productive_energy["workerAssignmentBlockedDetail"], "spawn_reserving_energy")
        self.assertEqual(room["workerAssignmentBlockedWorkers"], explicit_workers)
        self.assertEqual(productive_energy["workerAssignmentBlockedWorkers"], explicit_workers)
        reason, next_state = monitor.detect_worker_assignment_gap_sustained_reason(
            snapshot.ref,
            None,
            monitor.compute_room_summary_metrics(snapshot),
            {"start_tick": 999100, "last_tick": 999200, "consecutive_ticks": 100},
            snapshot.tick,
        )
        self.assertIsNotNone(reason)
        assert reason is not None
        self.assertEqual(reason["kind"], monitor.WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND)
        self.assertEqual(next_state["consecutive_ticks"], 173)

    def test_runtime_summary_payload_includes_worker_dispatch_diagnostics(self) -> None:
        snapshot = monitor.RoomSnapshot(
            ref=monitor.RoomRef(shard="shardX", room="E26S49"),
            terrain="0" * monitor.TERRAIN_CELLS,
            objects=monitor.normalize_objects(
                {
                    "site-1": {
                        "_id": "site-1",
                        "type": "constructionSite",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "structureType": "extension",
                        "progress": 0,
                        "progressTotal": 50,
                    },
                    "worker-1": {
                        "_id": "worker-1",
                        "type": "creep",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "name": "Upgrader",
                        "body": [
                            {"type": "work", "hits": 100},
                            {"type": "carry", "hits": 100},
                        ],
                        "store": {"energy": 50, "capacity": 100},
                        "memory": {
                            "role": "worker",
                            "task": {"type": "upgrade", "targetId": "controller1"},
                            "workerDispatchDiagnostic": {
                                "tick": 265633,
                                "reason": "retained_upgrade_task",
                                "selectedTask": "build",
                                "selectedTargetId": "extension-site",
                                "assignedTask": "upgrade",
                                "assignedTargetId": "controller1",
                            },
                        },
                    },
                }
            ),
            tick=265633,
            owner="lanyusea",
            info={"energyAvailable": 300},
        )

        payload = monitor.runtime_summary_payload_from_snapshots([snapshot])
        room = payload["rooms"][0]
        productive_energy = room["resources"]["productiveEnergy"]

        self.assertEqual(room["buildBlockedReason"], "worker_assignment_gap")
        self.assertEqual(room["workerAssignmentBlockedDetail"], "unknown")
        self.assertEqual(productive_energy["workerAssignmentBlockedDetail"], "unknown")
        self.assertEqual(
            room["workerAssignmentBlockedWorkers"],
            [
                {
                    "name": "Upgrader",
                    "task": "upgrade",
                    "carriedEnergy": 50,
                    "freeCapacity": 50,
                    "buildBlockedReason": "build_blocked_controller_progress_preferred",
                    "repairBlockedReason": "repair_blocked_build_backlog_first",
                    "dispatchReason": "retained_upgrade_task",
                    "dispatchTick": 265633,
                    "dispatchSelectedTask": "build",
                    "dispatchSelectedTargetId": "extension-site",
                    "dispatchAssignedTask": "upgrade",
                    "dispatchAssignedTargetId": "controller1",
                }
            ],
        )
        self.assertEqual(
            productive_energy["workerAssignmentBlockedWorkers"],
            room["workerAssignmentBlockedWorkers"],
        )

    def test_runtime_summary_does_not_label_unknown_structures_as_hostile(self) -> None:
        snapshot = monitor.RoomSnapshot(
            ref=monitor.RoomRef(shard="shardX", room="E26S49"),
            terrain="0" * monitor.TERRAIN_CELLS,
            objects={
                "controller-1": {"_id": "controller-1", "type": "controller", "user": "owner-id", "level": 3},
                "road-1": {"_id": "road-1", "type": "road", "hits": 100, "hitsMax": 500},
                "unknown-foreign-flag": {"_id": "unknown-foreign-flag", "type": "rampart", "my": False},
            },
            tick=265632,
            owner=None,
            info={},
        )

        payload = monitor.runtime_summary_payload_from_snapshots([snapshot])

        self.assertEqual(payload["rooms"][0]["combat"]["hostileStructureCount"], 0)

    def test_runtime_summary_counts_confirmed_foreign_owned_structures(self) -> None:
        snapshot = monitor.RoomSnapshot(
            ref=monitor.RoomRef(shard="shardX", room="E26S49"),
            terrain="0" * monitor.TERRAIN_CELLS,
            objects={
                "tower-1": {
                    "_id": "tower-1",
                    "type": "tower",
                    "owner": {"username": "Invader"},
                    "hits": 3000,
                    "hitsMax": 3000,
                },
            },
            tick=265633,
            owner="lanyusea",
            info={},
        )

        payload = monitor.runtime_summary_payload_from_snapshots([snapshot])

        self.assertEqual(payload["rooms"][0]["combat"]["hostileStructureCount"], 1)

    def test_runtime_summary_artifact_write_does_not_overwrite_existing_path(self) -> None:
        snapshot = monitor.RoomSnapshot(
            ref=monitor.RoomRef(shard="shardX", room="E26S49"),
            terrain="0" * monitor.TERRAIN_CELLS,
            objects={},
            tick=265634,
            owner="lanyusea",
            info={},
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            out_dir = Path(temp_dir)
            target = out_dir / monitor.runtime_summary_artifact_name()
            target.write_text("existing evidence\n", encoding="utf-8")

            written = monitor.write_runtime_summary_artifact([snapshot], out_dir)

            self.assertEqual(target.read_text(encoding="utf-8"), "existing evidence\n")
            self.assertEqual(written.name, target.with_name(f"{target.stem}-2{target.suffix}").name)
            self.assertTrue(written.read_text(encoding="utf-8").startswith("#runtime-summary "))

    def test_older_room_only_console_summary_does_not_override_newer_monitor_gap(self) -> None:
        console_payload = {
            "type": "runtime-summary",
            "tick": 995540,
            "rooms": [
                {
                    "roomName": "E29N55",
                    "energyBufferHealth": {"currentEnergy": 300, "threshold": 227, "healthy": True},
                    "workerCount": 3,
                    "taskCounts": {"harvest": 2, "transfer": 0, "build": 0, "repair": 0, "upgrade": 1, "none": 0},
                    "constructionSiteCount": 11,
                    "constructionDeadlockTicks": 0,
                    "resources": {
                        "productiveEnergy": {
                            "constructionSiteCount": 11,
                            "constructionDeadlockTicks": 0,
                        }
                    },
                }
            ],
        }
        monitor_payload = {
            "type": "runtime-summary",
            "source": monitor.MONITOR_RUNTIME_SUMMARY_SOURCE,
            "tick": 995544,
            "rooms": [
                {
                    "roomName": "E29N55",
                    "shard": "shardX",
                    "workerAssignmentEvidenceAvailable": True,
                    "workerCount": 3,
                    "taskCounts": {"harvest": 0, "transfer": 0, "build": 0, "repair": 0, "upgrade": 0, "none": 0},
                    "constructionSiteCount": 11,
                    "constructionDeadlockTicks": 1,
                    "buildBlockedReason": monitor.WORKER_ASSIGNMENT_GAP_BLOCKED_REASON,
                }
            ],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            (runtime_dir / "runtime-summary-console-20260515T234005Z.log").write_text(
                "#runtime-summary " + json.dumps(console_payload) + "\n",
                encoding="utf-8",
            )
            (runtime_dir / "runtime-summary-monitor-20260515T234012Z.log").write_text(
                "#runtime-summary " + json.dumps(monitor_payload) + "\n",
                encoding="utf-8",
            )
            warnings: list[str] = []

            runtime_rooms = monitor.load_latest_runtime_room_summaries(
                runtime_dir,
                [monitor.RoomRef(shard="shardX", room="E29N55")],
                warnings,
            )

        self.assertEqual(warnings, [])
        runtime_room = runtime_rooms["shardX/E29N55"]
        self.assertEqual(runtime_room["taskCounts"]["harvest"], 0)
        self.assertEqual(runtime_room["constructionDeadlockTicks"], 1)
        self.assertEqual(runtime_room["buildBlockedReason"], monitor.WORKER_ASSIGNMENT_GAP_BLOCKED_REASON)

    def test_fresh_room_only_console_summary_clears_stale_worker_assignment_gap(self) -> None:
        console_payload = {
            "type": "runtime-summary",
            "tick": 995548,
            "rooms": [
                {
                    "roomName": "E29N55",
                    "energyBufferHealth": {"currentEnergy": 300, "threshold": 227, "healthy": True},
                    "workerCount": 3,
                    "taskCounts": {"harvest": 2, "transfer": 0, "build": 0, "repair": 0, "upgrade": 1, "none": 0},
                    "constructionSiteCount": 11,
                    "constructionDeadlockTicks": 0,
                    "resources": {
                        "productiveEnergy": {
                            "constructionSiteCount": 11,
                            "constructionDeadlockTicks": 0,
                        }
                    },
                }
            ],
        }
        monitor_payload = {
            "type": "runtime-summary",
            "source": monitor.MONITOR_RUNTIME_SUMMARY_SOURCE,
            "tick": 995544,
            "rooms": [
                {
                    "roomName": "E29N55",
                    "shard": "shardX",
                    "workerAssignmentEvidenceAvailable": True,
                    "workerCount": 3,
                    "taskCounts": {"harvest": 0, "transfer": 0, "build": 0, "repair": 0, "upgrade": 0, "none": 0},
                    "constructionSiteCount": 11,
                    "constructionDeadlockTicks": 1,
                    "buildBlockedReason": monitor.WORKER_ASSIGNMENT_GAP_BLOCKED_REASON,
                }
            ],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            (runtime_dir / "runtime-summary-console-20260515T234020Z.log").write_text(
                "#runtime-summary " + json.dumps(console_payload) + "\n",
                encoding="utf-8",
            )
            (runtime_dir / "runtime-summary-monitor-20260515T234012Z.log").write_text(
                "#runtime-summary " + json.dumps(monitor_payload) + "\n",
                encoding="utf-8",
            )
            warnings: list[str] = []

            runtime_rooms = monitor.load_latest_runtime_room_summaries(
                runtime_dir,
                [monitor.RoomRef(shard="shardX", room="E29N55")],
                warnings,
            )

        self.assertEqual(warnings, [])
        runtime_room = runtime_rooms["shardX/E29N55"]
        self.assertEqual(runtime_room["taskCounts"]["harvest"], 2)
        self.assertEqual(runtime_room["constructionDeadlockTicks"], 0)
        self.assertIsNone(runtime_room.get("buildBlockedReason"))
        self.assertNotIn("buildBlockedReason", runtime_room["resources"]["productiveEnergy"])
        self.assertEqual(runtime_room[monitor.RUNTIME_SUMMARY_TICK_METADATA_KEY], 995548)
        self.assertIn(monitor.RUNTIME_SUMMARY_ARTIFACT_TIMESTAMP_METADATA_KEY, runtime_room)

        snapshot = monitor.RoomSnapshot(
            ref=monitor.RoomRef(shard="shardX", room="E29N55"),
            terrain="0" * monitor.TERRAIN_CELLS,
            objects=monitor.normalize_objects(
                {
                    "spawn1": {
                        "type": "spawn",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "x": 17,
                        "y": 24,
                        "hits": 5000,
                        "hitsMax": 5000,
                    },
                    "extension1": {
                        "type": "extension",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "x": 18,
                        "y": 24,
                        "hits": 1000,
                        "hitsMax": 1000,
                    },
                    "ctrl": {
                        "type": "controller",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "level": 2,
                        "x": 5,
                        "y": 36,
                    },
                    "worker-1": {"type": "creep", "my": True, "owner": {"username": "lanyusea"}, "name": "worker-1"},
                    "worker-2": {"type": "creep", "my": True, "owner": {"username": "lanyusea"}, "name": "worker-2"},
                    "worker-3": {"type": "creep", "my": True, "owner": {"username": "lanyusea"}, "name": "worker-3"},
                    "site1": {
                        "type": "constructionSite",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "structureType": "road",
                        "progress": 0,
                        "progressTotal": 50,
                        "x": 19,
                        "y": 24,
                    },
                }
            ),
            tick=995546,
            owner="lanyusea",
            info={"energyAvailable": 300},
            expected_owner="lanyusea",
        )
        previous_state = {
            "baseline_established": True,
            "owner": "lanyusea",
            "rule_counts": {
                monitor.WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND: {
                    "start_tick": 988884,
                    "last_tick": 995520,
                    "consecutive_ticks": 6636,
                }
            },
        }

        emitted, suppressed, next_state = monitor.evaluate_room_alert(
            snapshot,
            previous_state,
            now=100,
            debounce_seconds=300,
            runtime_room_summary=runtime_room,
        )

        self.assertEqual(suppressed, [])
        self.assertNotIn(monitor.WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND, [reason["kind"] for reason in emitted])
        self.assertEqual(next_state["rule_counts"][monitor.WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND], 0)

    def test_legacy_monitor_summary_without_assignment_evidence_does_not_sustain_worker_gap(self) -> None:
        monitor_payload = {
            "type": "runtime-summary",
            "tick": 999271,
            "rooms": [
                {
                    "roomName": "E29N55",
                    "shard": "shardX",
                    "taskCounts": {"harvest": 0, "transfer": 0, "build": 0, "repair": 0, "upgrade": 0, "none": 0},
                    "constructionSiteCount": 9,
                    "constructionDeadlockTicks": 1,
                    "buildBlockedReason": monitor.WORKER_ASSIGNMENT_GAP_BLOCKED_REASON,
                }
            ],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            (runtime_dir / "runtime-summary-monitor-20260516T020155Z.log").write_text(
                "#runtime-summary " + json.dumps(monitor_payload) + "\n",
                encoding="utf-8",
            )
            warnings: list[str] = []

            runtime_rooms = monitor.load_latest_runtime_room_summaries(
                runtime_dir,
                [monitor.RoomRef(shard="shardX", room="E29N55")],
                warnings,
            )

        self.assertEqual(warnings, [])
        runtime_room = runtime_rooms["shardX/E29N55"]
        self.assertEqual(
            runtime_room[monitor.RUNTIME_SUMMARY_SOURCE_METADATA_KEY],
            monitor.MONITOR_RUNTIME_SUMMARY_SOURCE,
        )
        self.assertFalse(monitor.runtime_worker_assignment_evidence_available(runtime_room))

        snapshot = monitor.RoomSnapshot(
            ref=monitor.RoomRef(shard="shardX", room="E29N55"),
            terrain="0" * monitor.TERRAIN_CELLS,
            objects=monitor.normalize_objects(
                {
                    "spawn1": {
                        "type": "spawn",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "x": 17,
                        "y": 24,
                        "hits": 5000,
                        "hitsMax": 5000,
                    },
                    "extension1": {
                        "type": "extension",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "x": 18,
                        "y": 24,
                        "hits": 1000,
                        "hitsMax": 1000,
                    },
                    "ctrl": {
                        "type": "controller",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "level": 2,
                        "x": 5,
                        "y": 36,
                    },
                    "worker-1": {
                        "type": "creep",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "name": "worker-1",
                    },
                    "worker-2": {
                        "type": "creep",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "name": "worker-2",
                    },
                    "site1": {
                        "type": "constructionSite",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "structureType": "road",
                        "progress": 0,
                        "progressTotal": 50,
                        "x": 19,
                        "y": 24,
                    },
                }
            ),
            tick=999274,
            owner="lanyusea",
            info={"energyAvailable": 333},
            expected_owner="lanyusea",
        )
        previous_state = {
            "baseline_established": True,
            "owner": "lanyusea",
            "rule_counts": {
                monitor.WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND: {
                    "start_tick": 988884,
                    "last_tick": 999271,
                    "consecutive_ticks": 10387,
                }
            },
        }

        emitted, suppressed, next_state = monitor.evaluate_room_alert(
            snapshot,
            previous_state,
            now=100,
            debounce_seconds=300,
            runtime_room_summary=runtime_room,
        )

        self.assertEqual(suppressed, [])
        self.assertNotIn(monitor.WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND, [reason["kind"] for reason in emitted])
        self.assertEqual(next_state["rule_counts"][monitor.WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND], 0)

    def test_legacy_monitor_summary_blocked_worker_paths_count_as_assignment_evidence(self) -> None:
        blocked_worker = {"name": "WorkerA", "task": "upgrade"}
        cases = {
            "root detail": {"workerAssignmentBlockedDetail": "spawn_reserving_energy"},
            "resources workers": {
                "resources": {"productiveEnergy": {"workerAssignmentBlockedWorkers": [blocked_worker]}}
            },
            "legacy productive detail": {
                "productiveEnergy": {"workerAssignmentBlockedDetail": "spawn_reserving_energy"}
            },
        }

        for name, fields in cases.items():
            with self.subTest(name=name):
                runtime_room = {
                    "roomName": "E29N55",
                    "shard": "shardX",
                    monitor.RUNTIME_SUMMARY_SOURCE_METADATA_KEY: monitor.MONITOR_RUNTIME_SUMMARY_SOURCE,
                    **fields,
                }

                self.assertTrue(monitor.runtime_worker_assignment_evidence_available(runtime_room))

    def test_legacy_monitor_summary_blocked_worker_detail_sustains_worker_gap_alert(self) -> None:
        blocked_workers = [{"name": "WorkerA", "task": "upgrade", "carriedEnergy": 50}]
        monitor_payload = {
            "type": "runtime-summary",
            "tick": 999274,
            "rooms": [
                {
                    "roomName": "E29N55",
                    "shard": "shardX",
                    "taskCounts": {"harvest": 0, "transfer": 0, "build": 0, "repair": 0, "upgrade": 0, "none": 0},
                    "constructionSiteCount": 9,
                    "constructionDeadlockTicks": 1,
                    "resources": {
                        "productiveEnergy": {
                            "buildBlockedReason": monitor.WORKER_ASSIGNMENT_GAP_BLOCKED_REASON,
                            "workerAssignmentBlockedDetail": "spawn_reserving_energy",
                            "workerAssignmentBlockedWorkers": blocked_workers,
                        }
                    },
                }
            ],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            (runtime_dir / "runtime-summary-monitor-20260516T020200Z.log").write_text(
                "#runtime-summary " + json.dumps(monitor_payload) + "\n",
                encoding="utf-8",
            )
            warnings: list[str] = []

            runtime_rooms = monitor.load_latest_runtime_room_summaries(
                runtime_dir,
                [monitor.RoomRef(shard="shardX", room="E29N55")],
                warnings,
            )

        self.assertEqual(warnings, [])
        runtime_room = runtime_rooms["shardX/E29N55"]
        self.assertNotIn("workerAssignmentEvidenceAvailable", runtime_room)
        self.assertTrue(monitor.runtime_worker_assignment_evidence_available(runtime_room))
        self.assertTrue(monitor.runtime_reports_worker_assignment_gap(runtime_room))

        snapshot = monitor.RoomSnapshot(
            ref=monitor.RoomRef(shard="shardX", room="E29N55"),
            terrain="0" * monitor.TERRAIN_CELLS,
            objects=monitor.normalize_objects(
                {
                    "spawn1": {
                        "type": "spawn",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "x": 17,
                        "y": 24,
                        "hits": 5000,
                        "hitsMax": 5000,
                    },
                    "extension1": {
                        "type": "extension",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "x": 18,
                        "y": 24,
                        "hits": 1000,
                        "hitsMax": 1000,
                    },
                    "ctrl": {
                        "type": "controller",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "level": 2,
                        "x": 5,
                        "y": 36,
                    },
                    "worker-1": {"type": "creep", "my": True, "owner": {"username": "lanyusea"}, "name": "worker-1"},
                    "worker-2": {"type": "creep", "my": True, "owner": {"username": "lanyusea"}, "name": "worker-2"},
                    "site1": {
                        "type": "constructionSite",
                        "my": True,
                        "owner": {"username": "lanyusea"},
                        "structureType": "road",
                        "progress": 0,
                        "progressTotal": 50,
                        "x": 19,
                        "y": 24,
                    },
                }
            ),
            tick=999274,
            owner="lanyusea",
            info={"energyAvailable": 333},
            expected_owner="lanyusea",
        )
        previous_state = {
            "baseline_established": True,
            "owner": "lanyusea",
            "rule_counts": {
                monitor.WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND: {
                    "start_tick": 999100,
                    "last_tick": 999200,
                    "consecutive_ticks": 100,
                }
            },
        }

        emitted, suppressed, next_state = monitor.evaluate_room_alert(
            snapshot,
            previous_state,
            now=100,
            debounce_seconds=300,
            runtime_room_summary=runtime_room,
        )

        self.assertEqual(suppressed, [])
        worker_gap_reasons = [
            reason for reason in emitted if reason["kind"] == monitor.WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND
        ]
        self.assertEqual(len(worker_gap_reasons), 1)
        self.assertEqual(
            worker_gap_reasons[0]["buildBlockedReason"],
            monitor.WORKER_ASSIGNMENT_GAP_BLOCKED_REASON,
        )
        self.assertEqual(
            next_state["rule_counts"][monitor.WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND]["consecutive_ticks"],
            174,
        )

    def test_productive_assignment_stall_summary_alerts_after_100_ticks(self) -> None:
        blocked_workers = [{"name": "WorkerA", "task": "build", "carriedEnergy": 0}]
        runtime_room = {
            "roomName": "E29N57",
            "shard": "shardX",
            monitor.RUNTIME_SUMMARY_TICK_METADATA_KEY: 123000,
            monitor.RUNTIME_SUMMARY_ARTIFACT_TIMESTAMP_METADATA_KEY: "2026-06-01T00:00:00Z",
            "workerAssignmentEvidenceAvailable": True,
            "workerAssignmentEvidence": {
                "source": "runtime-summary",
                "available": True,
                "tick": 123000,
                "workerCount": 2,
                "assignedTaskCount": 0,
                "productiveAssignmentCount": 0,
            },
            "taskCounts": {"harvest": 0, "transfer": 0, "build": 0, "repair": 0, "upgrade": 0, "none": 2},
            "constructionSiteCount": 9,
            "pendingBuildProgress": 4500,
            "workerAssignmentBlockedDetail": "spawn_reserving_energy",
            "workerAssignmentBlockedWorkers": blocked_workers,
            "resources": {
                "productiveEnergy": {
                    "constructionSiteCount": 9,
                    "pendingBuildProgress": 4500,
                    "workerAssignmentBlockedDetail": "spawn_reserving_energy",
                    "workerAssignmentBlockedWorkers": blocked_workers,
                }
            },
        }
        objects = {
            "spawn1": {
                "type": "spawn",
                "my": True,
                "owner": {"username": "lanyusea"},
                "x": 17,
                "y": 24,
                "hits": 5000,
                "hitsMax": 5000,
            },
            "extension1": {
                "type": "extension",
                "my": True,
                "owner": {"username": "lanyusea"},
                "x": 18,
                "y": 24,
                "hits": 1000,
                "hitsMax": 1000,
            },
            "ctrl": {
                "type": "controller",
                "my": True,
                "owner": {"username": "lanyusea"},
                "level": 2,
                "x": 5,
                "y": 36,
            },
            "worker-1": {
                "type": "creep",
                "my": True,
                "owner": {"username": "lanyusea"},
                "name": "WorkerA",
                "memory": {"role": "worker"},
            },
            "worker-2": {
                "type": "creep",
                "my": True,
                "owner": {"username": "lanyusea"},
                "name": "WorkerB",
                "memory": {"role": "worker"},
            },
            "site1": {
                "type": "constructionSite",
                "my": True,
                "owner": {"username": "lanyusea"},
                "structureType": "extension",
                "progress": 0,
                "progressTotal": 4500,
                "x": 19,
                "y": 24,
            },
        }
        first_snapshot = monitor.RoomSnapshot(
            ref=monitor.RoomRef(shard="shardX", room="E29N57"),
            terrain="0" * monitor.TERRAIN_CELLS,
            objects=monitor.normalize_objects(objects),
            tick=123000,
            owner="lanyusea",
            info={"energyAvailable": 300},
            expected_owner="lanyusea",
        )
        second_snapshot = monitor.RoomSnapshot(
            ref=monitor.RoomRef(shard="shardX", room="E29N57"),
            terrain="0" * monitor.TERRAIN_CELLS,
            objects=monitor.normalize_objects(objects),
            tick=123101,
            owner="lanyusea",
            info={"energyAvailable": 300},
            expected_owner="lanyusea",
        )
        second_runtime_room = {
            **runtime_room,
            monitor.RUNTIME_SUMMARY_TICK_METADATA_KEY: 123101,
            "workerAssignmentEvidence": {
                **runtime_room["workerAssignmentEvidence"],
                "tick": 123101,
            },
        }

        first_emitted, first_suppressed, first_state = monitor.evaluate_room_alert(
            first_snapshot,
            {"baseline_established": True, "owner": "lanyusea"},
            now=100,
            debounce_seconds=300,
            runtime_room_summary=runtime_room,
        )
        second_emitted, second_suppressed, second_state = monitor.evaluate_room_alert(
            second_snapshot,
            first_state,
            now=200,
            debounce_seconds=300,
            runtime_room_summary=second_runtime_room,
        )

        self.assertEqual(first_emitted, [])
        self.assertEqual(first_suppressed, [])
        self.assertEqual(second_suppressed, [])
        self.assertNotIn(monitor.WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND, [reason["kind"] for reason in second_emitted])
        stall_reason = next(reason for reason in second_emitted if reason["kind"] == monitor.WORKER_ASSIGNMENT_STALL_KIND)
        self.assertEqual(stall_reason["room"], "shardX/E29N57")
        self.assertEqual(stall_reason["shard"], "shardX")
        self.assertEqual(stall_reason["workerAssignmentBlockedDetail"], "spawn_reserving_energy")
        self.assertEqual(stall_reason["blocked_detail"], "spawn_reserving_energy")
        self.assertEqual(stall_reason["productiveAssignmentCount"], 0)
        self.assertEqual(stall_reason["pendingBuildProgress"], 4500)
        self.assertEqual(stall_reason["constructionSiteCount"], 9)
        self.assertEqual(stall_reason["build"], 0)
        self.assertEqual(stall_reason["workerAssignmentBlockedWorkers"], blocked_workers)
        self.assertEqual(stall_reason["runtimeSummaryTick"], 123101)
        self.assertEqual(stall_reason["consecutive_ticks"], 101)
        self.assertEqual(
            second_state["rule_counts"][monitor.WORKER_ASSIGNMENT_STALL_KIND]["consecutive_ticks"],
            101,
        )

        report = monitor.build_tactical_response_report(
            {"ok": True, "mode": "alert", "alert": True, "reasons": [stall_reason], "rooms": ["shardX/E29N57"]}
        )
        self.assertTrue(report["emergency"])
        self.assertEqual(report["severity"], "warning")
        self.assertEqual(report["priority"], "P2")
        self.assertEqual(report["categories"], [monitor.WORKER_ASSIGNMENT_STALL_KIND])
        self.assertEqual(report["triggers"][0]["reason_kind"], monitor.WORKER_ASSIGNMENT_STALL_KIND)
        self.assertIn("#1573", report["triggers"][0]["metadata"]["related_issues"])

    def test_persistent_worker_deadlock_console_captures_alert_after_four_captures(self) -> None:
        room = "E29N57"
        ticks = [1630662, 1630668, 1630675, 1630685]
        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            paths: list[Path] = []
            for index, tick in enumerate(ticks, start=1):
                path = runtime_dir / f"runtime-summary-console-20260601T00000{index}Z.log"
                path.write_text(
                    "#runtime-summary "
                    + json.dumps(
                        worker_deadlock_runtime_summary_payload(
                            room,
                            tick,
                            productive_assignment_count=0,
                            blocked_detail="spawn_reserving_energy",
                        )
                    )
                    + "\n",
                    encoding="utf-8",
                )
                paths.append(path)

            warnings: list[str] = []
            runtime_rooms = monitor.load_latest_runtime_room_summaries(
                runtime_dir,
                [monitor.RoomRef(shard="shardX", room=room)],
                warnings,
            )

        self.assertEqual(warnings, [])
        runtime_room = runtime_rooms[f"shardX/{room}"]
        self.assertEqual(runtime_room[monitor.RUNTIME_SUMMARY_TICK_METADATA_KEY], ticks[-1])
        self.assertEqual(
            len(runtime_room[monitor.RUNTIME_SUMMARY_CAPTURE_HISTORY_METADATA_KEY]),
            monitor.WORKER_ASSIGNMENT_STALL_REQUIRED_CONSECUTIVE_CAPTURES,
        )

        emitted, suppressed, _next_state = monitor.evaluate_room_alert(
            make_owned_worker_room_snapshot(room, ticks[-1]),
            {"baseline_established": True, "owner": "lanyusea"},
            now=100,
            debounce_seconds=300,
            runtime_room_summary=runtime_room,
        )

        self.assertEqual(suppressed, [])
        stall_reason = next(reason for reason in emitted if reason["kind"] == monitor.WORKER_ASSIGNMENT_STALL_KIND)
        self.assertEqual(stall_reason["room"], f"shardX/{room}")
        self.assertEqual(stall_reason["workerAssignmentBlockedDetail"], "spawn_reserving_energy")
        self.assertEqual(stall_reason["productiveAssignmentCount"], 0)
        self.assertEqual(stall_reason["consecutiveCaptures"], 4)
        self.assertEqual(stall_reason["thresholdCaptures"], 4)
        self.assertEqual(stall_reason["runtimeSummaryTick"], ticks[-1])
        self.assertEqual(stall_reason["runtimeSummaryCaptures"][0]["runtimeSummaryTick"], ticks[-1])
        self.assertEqual(set(stall_reason["runtimeSummaryCapturePaths"]), {str(path) for path in paths})
        self.assertIn("Codex triage", stall_reason["next_action"])
        self.assertIs(stall_reason["owner_ping"], False)

        report = monitor.build_tactical_response_report(
            {"ok": True, "mode": "alert", "alert": True, "reasons": [stall_reason], "rooms": [f"shardX/{room}"]}
        )
        self.assertEqual(report["priority"], "P2")
        self.assertIn("#1580", report["triggers"][0]["metadata"]["related_issues"])
        self.assertIn("#1553", report["triggers"][0]["metadata"]["related_issues"])

    def test_worker_deadlock_console_capture_window_requires_fresh_latest_capture(self) -> None:
        room = "E29N57"
        ticks = [1630662, 1630668, 1630675, 1630685]
        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            for index, tick in enumerate(ticks, start=1):
                (runtime_dir / f"runtime-summary-console-20260601T00000{index}Z.log").write_text(
                    "#runtime-summary "
                    + json.dumps(
                        worker_deadlock_runtime_summary_payload(
                            room,
                            tick,
                            productive_assignment_count=0,
                            blocked_detail="spawn_reserving_energy",
                        )
                    )
                    + "\n",
                    encoding="utf-8",
                )
            (runtime_dir / "runtime-summary-console-20260601T000100Z.log").write_text(
                "#cpu-summary " + json.dumps({"used": 4.2, "limit": 70, "bucket": 9000, "pressure": "normal"}) + "\n",
                encoding="utf-8",
            )

            warnings: list[str] = []
            runtime_rooms = monitor.load_latest_runtime_room_summaries(
                runtime_dir,
                [monitor.RoomRef(shard="shardX", room=room)],
                warnings,
            )

        self.assertEqual(warnings, [])
        runtime_room = runtime_rooms[f"shardX/{room}"]
        self.assertEqual(
            runtime_room[monitor.RUNTIME_SUMMARY_CAPTURE_HISTORY_METADATA_KEY][0]["runtimeSummaryTick"],
            ticks[-1],
        )
        emitted, suppressed, _next_state = monitor.evaluate_room_alert(
            make_owned_worker_room_snapshot(room, ticks[-1] + 25),
            {"baseline_established": True, "owner": "lanyusea"},
            now=100,
            debounce_seconds=300,
            runtime_room_summary=runtime_room,
        )

        self.assertEqual(suppressed, [])
        self.assertNotIn(monitor.WORKER_ASSIGNMENT_STALL_KIND, [reason["kind"] for reason in emitted])

    def test_worker_deadlock_console_capture_without_build_backlog_stays_silent(self) -> None:
        room = "E29N57"
        ticks = [1630662, 1630668, 1630675, 1630685]
        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            for index, tick in enumerate(ticks, start=1):
                payload = worker_deadlock_runtime_summary_payload(
                    room,
                    tick,
                    productive_assignment_count=0,
                    blocked_detail="spawn_reserving_energy",
                )
                room_summary = payload["rooms"][0]
                productive_energy = room_summary["resources"]["productiveEnergy"]
                room_summary["constructionSiteCount"] = 0
                room_summary["pendingBuildProgress"] = 0
                productive_energy["constructionSiteCount"] = 0
                productive_energy["pendingBuildProgress"] = 0
                (runtime_dir / f"runtime-summary-console-20260601T00000{index}Z.log").write_text(
                    "#runtime-summary " + json.dumps(payload) + "\n",
                    encoding="utf-8",
                )

            warnings: list[str] = []
            runtime_rooms = monitor.load_latest_runtime_room_summaries(
                runtime_dir,
                [monitor.RoomRef(shard="shardX", room=room)],
                warnings,
            )

        self.assertEqual(warnings, [])
        emitted, suppressed, _next_state = monitor.evaluate_room_alert(
            make_owned_worker_room_snapshot(room, ticks[-1]),
            {"baseline_established": True, "owner": "lanyusea"},
            now=100,
            debounce_seconds=300,
            runtime_room_summary=runtime_rooms[f"shardX/{room}"],
        )

        self.assertEqual(suppressed, [])
        self.assertNotIn(monitor.WORKER_ASSIGNMENT_STALL_KIND, [reason["kind"] for reason in emitted])

    def test_worker_deadlock_console_capture_gap_window_stays_silent(self) -> None:
        room = "E29N57"
        ticks = [1630662, 1630668, 1630675, 1630685]
        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            for index, tick in enumerate(ticks, start=1):
                payload = worker_deadlock_runtime_summary_payload(
                    room,
                    tick,
                    productive_assignment_count=0,
                    blocked_detail="spawn_reserving_energy",
                )
                room_summary = payload["rooms"][0]
                productive_energy = room_summary["resources"]["productiveEnergy"]
                room_summary["buildBlockedReason"] = monitor.WORKER_ASSIGNMENT_GAP_BLOCKED_REASON
                productive_energy["buildBlockedReason"] = monitor.WORKER_ASSIGNMENT_GAP_BLOCKED_REASON
                (runtime_dir / f"runtime-summary-console-20260601T00000{index}Z.log").write_text(
                    "#runtime-summary " + json.dumps(payload) + "\n",
                    encoding="utf-8",
                )

            warnings: list[str] = []
            runtime_rooms = monitor.load_latest_runtime_room_summaries(
                runtime_dir,
                [monitor.RoomRef(shard="shardX", room=room)],
                warnings,
            )

        self.assertEqual(warnings, [])
        emitted, suppressed, _next_state = monitor.evaluate_room_alert(
            make_owned_worker_room_snapshot(room, ticks[-1]),
            {"baseline_established": True, "owner": "lanyusea"},
            now=100,
            debounce_seconds=300,
            runtime_room_summary=runtime_rooms[f"shardX/{room}"],
        )

        self.assertEqual(suppressed, [])
        self.assertNotIn(monitor.WORKER_ASSIGNMENT_STALL_KIND, [reason["kind"] for reason in emitted])

    def test_worker_deadlock_console_capture_nested_zero_worker_count_stays_silent(self) -> None:
        room = "E29N57"
        ticks = [1630662, 1630668, 1630675, 1630685]
        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            for index, tick in enumerate(ticks, start=1):
                payload = {
                    "type": "runtime-summary",
                    "tick": tick,
                    "rooms": [
                        {
                            "roomName": room,
                            "shard": "shardX",
                            "workerAssignmentEvidenceAvailable": True,
                            "taskCounts": {
                                "harvest": 0,
                                "transfer": 0,
                                "build": 0,
                                "repair": 0,
                                "upgrade": 0,
                                "none": 0,
                            },
                            "resources": {
                                "productiveEnergy": {
                                    "workerCount": 0,
                                    "constructionSiteCount": 1,
                                    "pendingBuildProgress": 4500,
                                    "productiveAssignmentCount": 0,
                                    "workerAssignmentBlockedDetail": "spawn_reserving_energy",
                                }
                            },
                        }
                    ],
                }
                (runtime_dir / f"runtime-summary-console-20260601T00000{index}Z.log").write_text(
                    "#runtime-summary " + json.dumps(payload) + "\n",
                    encoding="utf-8",
                )

            warnings: list[str] = []
            runtime_rooms = monitor.load_latest_runtime_room_summaries(
                runtime_dir,
                [monitor.RoomRef(shard="shardX", room=room)],
                warnings,
            )

        self.assertEqual(warnings, [])
        runtime_room = runtime_rooms[f"shardX/{room}"]
        self.assertEqual(
            runtime_room[monitor.RUNTIME_SUMMARY_CAPTURE_HISTORY_METADATA_KEY][0]["workerCount"],
            0,
        )
        emitted, suppressed, _next_state = monitor.evaluate_room_alert(
            make_owned_worker_room_snapshot(room, ticks[-1]),
            {"baseline_established": True, "owner": "lanyusea"},
            now=100,
            debounce_seconds=300,
            runtime_room_summary=runtime_room,
        )

        self.assertEqual(suppressed, [])
        self.assertNotIn(monitor.WORKER_ASSIGNMENT_STALL_KIND, [reason["kind"] for reason in emitted])

    def test_worker_deadlock_console_capture_prefers_top_level_worker_count(self) -> None:
        room = "E29N57"
        ticks = [1630662, 1630668, 1630675, 1630685]
        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            for index, tick in enumerate(ticks, start=1):
                payload = worker_deadlock_runtime_summary_payload(
                    room,
                    tick,
                    productive_assignment_count=0,
                    blocked_detail="spawn_reserving_energy",
                )
                room_summary = payload["rooms"][0]
                room_summary["workerAssignmentEvidence"].pop("workerCount", None)
                room_summary["resources"]["productiveEnergy"]["workerCount"] = 0
                (runtime_dir / f"runtime-summary-console-20260601T00000{index}Z.log").write_text(
                    "#runtime-summary " + json.dumps(payload) + "\n",
                    encoding="utf-8",
                )

            warnings: list[str] = []
            runtime_rooms = monitor.load_latest_runtime_room_summaries(
                runtime_dir,
                [monitor.RoomRef(shard="shardX", room=room)],
                warnings,
            )

        self.assertEqual(warnings, [])
        runtime_room = runtime_rooms[f"shardX/{room}"]
        self.assertEqual(
            runtime_room[monitor.RUNTIME_SUMMARY_CAPTURE_HISTORY_METADATA_KEY][0]["workerCount"],
            2,
        )
        emitted, suppressed, _next_state = monitor.evaluate_room_alert(
            make_owned_worker_room_snapshot(room, ticks[-1]),
            {"baseline_established": True, "owner": "lanyusea"},
            now=100,
            debounce_seconds=300,
            runtime_room_summary=runtime_room,
        )

        self.assertEqual(suppressed, [])
        stall_reason = next(reason for reason in emitted if reason["kind"] == monitor.WORKER_ASSIGNMENT_STALL_KIND)
        self.assertEqual(stall_reason["workerCount"], 2)

    def test_worker_deadlock_console_capture_transient_window_stays_silent(self) -> None:
        room = "E29N57"
        captures = [
            (1630662, 0, "spawn_reserving_energy"),
            (1630668, 0, "spawn_reserving_energy"),
            (1630675, 1, None),
            (1630680, 0, "spawn_reserving_energy"),
            (1630685, 0, "spawn_reserving_energy"),
            (1630690, 0, "spawn_reserving_energy"),
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            for index, (tick, productive_count, blocked_detail) in enumerate(captures, start=1):
                (runtime_dir / f"runtime-summary-console-20260601T00000{index}Z.log").write_text(
                    "#runtime-summary "
                    + json.dumps(
                        worker_deadlock_runtime_summary_payload(
                            room,
                            tick,
                            productive_assignment_count=productive_count,
                            blocked_detail=blocked_detail,
                        )
                    )
                    + "\n",
                    encoding="utf-8",
                )

            warnings: list[str] = []
            runtime_rooms = monitor.load_latest_runtime_room_summaries(
                runtime_dir,
                [monitor.RoomRef(shard="shardX", room=room)],
                warnings,
            )

        self.assertEqual(warnings, [])
        emitted, suppressed, _next_state = monitor.evaluate_room_alert(
            make_owned_worker_room_snapshot(room, captures[-1][0]),
            {"baseline_established": True, "owner": "lanyusea"},
            now=100,
            debounce_seconds=300,
            runtime_room_summary=runtime_rooms[f"shardX/{room}"],
        )

        self.assertEqual(suppressed, [])
        self.assertNotIn(monitor.WORKER_ASSIGNMENT_STALL_KIND, [reason["kind"] for reason in emitted])

    def test_productive_assignment_stall_stale_runtime_summary_does_not_age(self) -> None:
        runtime_room = {
            "roomName": "E26S49",
            "shard": "shardX",
            monitor.RUNTIME_SUMMARY_TICK_METADATA_KEY: 123000,
            "workerAssignmentEvidenceAvailable": True,
            "workerAssignmentEvidence": {
                "source": "runtime-summary",
                "available": True,
                "tick": 123000,
                "workerCount": 1,
                "assignedTaskCount": 0,
                "productiveAssignmentCount": 0,
            },
            "taskCounts": {"harvest": 0, "transfer": 0, "build": 0, "repair": 0, "upgrade": 0, "none": 1},
            "constructionSiteCount": 1,
            "pendingBuildProgress": 50,
            "workerAssignmentBlockedDetail": "spawn_reserving_energy",
        }
        objects = {
            "spawn1": {
                "type": "spawn",
                "my": True,
                "owner": {"username": "owner"},
                "x": 25,
                "y": 25,
                "hits": 5000,
                "hitsMax": 5000,
            },
            "extension1": {
                "type": "extension",
                "my": True,
                "owner": {"username": "owner"},
                "x": 26,
                "y": 25,
                "hits": 1000,
                "hitsMax": 1000,
            },
            "worker1": {
                "type": "creep",
                "my": True,
                "owner": {"username": "owner"},
                "name": "worker1",
                "memory": {"role": "worker"},
            },
            "site1": {
                "type": "constructionSite",
                "my": True,
                "owner": {"username": "owner"},
                "structureType": "road",
                "progress": 0,
                "progressTotal": 50,
                "x": 24,
                "y": 24,
            },
        }
        first_snapshot = make_snapshot(objects, tick=123000)
        second_snapshot = make_snapshot(objects, tick=123101)

        first_emitted, first_suppressed, first_state = monitor.evaluate_room_alert(
            first_snapshot,
            {"baseline_established": True, "owner": "owner"},
            now=100,
            debounce_seconds=300,
            runtime_room_summary=runtime_room,
        )
        second_emitted, second_suppressed, second_state = monitor.evaluate_room_alert(
            second_snapshot,
            first_state,
            now=200,
            debounce_seconds=300,
            runtime_room_summary=runtime_room,
        )

        self.assertEqual(first_emitted, [])
        self.assertEqual(first_suppressed, [])
        self.assertEqual(second_emitted, [])
        self.assertEqual(second_suppressed, [])
        self.assertEqual(
            second_state["rule_counts"][monitor.WORKER_ASSIGNMENT_STALL_KIND],
            {"start_tick": 123000, "last_tick": 123000, "consecutive_ticks": 0},
        )

    def test_productive_assignment_stall_missing_or_healthy_evidence_stays_silent(self) -> None:
        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "worker1": {
                    "type": "creep",
                    "my": True,
                    "owner": {"username": "owner"},
                    "name": "worker1",
                    "memory": {"role": "worker"},
                },
                "site1": {
                    "type": "constructionSite",
                    "my": True,
                    "owner": {"username": "owner"},
                    "structureType": "road",
                    "progress": 0,
                    "progressTotal": 50,
                    "x": 24,
                    "y": 24,
                },
            },
            tick=1101,
        )
        base_room = {
            "roomName": "E26S49",
            "shard": "shardX",
            monitor.RUNTIME_SUMMARY_TICK_METADATA_KEY: 1101,
            "workerAssignmentEvidenceAvailable": True,
            "taskCounts": {"harvest": 0, "transfer": 0, "build": 0, "repair": 0, "upgrade": 0, "none": 1},
            "constructionSiteCount": 1,
            "pendingBuildProgress": 50,
        }
        cases = {
            "missing productive assignment count": {
                **base_room,
                "workerAssignmentBlockedDetail": "spawn_reserving_energy",
            },
            "missing blocked detail": {
                **base_room,
                "workerAssignmentEvidence": {
                    "source": "runtime-summary",
                    "available": True,
                    "tick": 1101,
                    "workerCount": 1,
                    "assignedTaskCount": 0,
                    "productiveAssignmentCount": 0,
                },
            },
            "productive assignment recovered": {
                **base_room,
                "workerAssignmentEvidence": {
                    "source": "runtime-summary",
                    "available": True,
                    "tick": 1101,
                    "workerCount": 1,
                    "assignedTaskCount": 1,
                    "productiveAssignmentCount": 1,
                },
                "workerAssignmentBlockedDetail": "spawn_reserving_energy",
            },
        }

        for name, runtime_room in cases.items():
            with self.subTest(name=name):
                emitted, suppressed, next_state = monitor.evaluate_room_alert(
                    snapshot,
                    {
                        "baseline_established": True,
                        "owner": "owner",
                        "rule_counts": {
                            monitor.WORKER_ASSIGNMENT_STALL_KIND: {
                                "start_tick": 1000,
                                "last_tick": 1100,
                                "consecutive_ticks": 100,
                            }
                        },
                    },
                    now=100,
                    debounce_seconds=300,
                    runtime_room_summary=runtime_room,
                )

                self.assertEqual(suppressed, [])
                self.assertNotIn(monitor.WORKER_ASSIGNMENT_STALL_KIND, [reason["kind"] for reason in emitted])
                self.assertEqual(next_state["rule_counts"][monitor.WORKER_ASSIGNMENT_STALL_KIND], 0)

    def test_legacy_monitor_summary_blocked_worker_detail_allows_worker_gap_recovery(self) -> None:
        runtime_room = {
            "roomName": "E29N55",
            "shard": "shardX",
            monitor.RUNTIME_SUMMARY_SOURCE_METADATA_KEY: monitor.MONITOR_RUNTIME_SUMMARY_SOURCE,
            monitor.RUNTIME_SUMMARY_TICK_METADATA_KEY: 1101,
            "workerCount": 3,
            "taskCounts": {"harvest": 1, "transfer": 0, "build": 0, "repair": 0, "upgrade": 0, "none": 0},
            "constructionSiteCount": 9,
            "constructionDeadlockTicks": 0,
            "workerAssignmentBlockedDetail": "spawn_reserving_energy",
        }

        self.assertTrue(monitor.runtime_worker_assignment_evidence_available(runtime_room))
        self.assertTrue(monitor.runtime_worker_assignment_gap_recovered(runtime_room))

        reason, next_state = monitor.detect_worker_assignment_gap_sustained_reason(
            monitor.RoomRef(shard="shardX", room="E29N55"),
            runtime_room,
            make_worker_assignment_gap_metrics(),
            {"start_tick": 1000, "last_tick": 1100, "consecutive_ticks": 100},
            1101,
        )

        self.assertIsNone(reason)
        self.assertEqual(next_state, 0)

    def test_stale_recovered_summary_does_not_clear_newer_worker_assignment_gap(self) -> None:
        console_payload = {
            "type": "runtime-summary",
            "tick": 995548,
            "rooms": [
                {
                    "roomName": "E29N55",
                    "workerCount": 3,
                    "taskCounts": {"harvest": 2, "transfer": 0, "build": 0, "repair": 0, "upgrade": 1, "none": 0},
                    "constructionSiteCount": 0,
                    "constructionDeadlockTicks": 0,
                }
            ],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            (runtime_dir / "runtime-summary-console-20260515T234020Z.log").write_text(
                "#runtime-summary " + json.dumps(console_payload) + "\n",
                encoding="utf-8",
            )
            warnings: list[str] = []

            runtime_rooms = monitor.load_latest_runtime_room_summaries(
                runtime_dir,
                [monitor.RoomRef(shard="shardX", room="E29N55")],
                warnings,
            )

        self.assertEqual(warnings, [])
        runtime_room = runtime_rooms["shardX/E29N55"]
        self.assertEqual(runtime_room[monitor.RUNTIME_SUMMARY_TICK_METADATA_KEY], 995548)

        reason, next_state = monitor.detect_worker_assignment_gap_sustained_reason(
            monitor.RoomRef(shard="shardX", room="E29N55"),
            runtime_room,
            make_worker_assignment_gap_metrics(),
            {"start_tick": 995500, "last_tick": 995600, "consecutive_ticks": 100},
            995650,
        )

        self.assertIsNotNone(reason)
        assert reason is not None
        self.assertEqual(reason["kind"], monitor.WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND)
        self.assertEqual(reason["buildBlockedReason"], monitor.WORKER_ASSIGNMENT_GAP_BLOCKED_REASON)
        self.assertEqual(reason["constructionSiteCount"], 1)
        self.assertEqual(next_state["consecutive_ticks"], 150)

    def test_extension_bootstrap_state_preserves_zero_last_progress_tick_without_progress(self) -> None:
        state = monitor.extension_bootstrap_next_state(
            {
                "start_tick": 0,
                "last_tick": 10,
                "last_progress_tick": 0,
                "extension_construction_site_count": 1,
                "extension_pending_build_progress": 2900,
                "stalled_ticks": 10,
            },
            current_tick=25,
            extension_construction_site_count=1,
            extension_pending_build_progress=2900,
        )

        self.assertEqual(state["last_progress_tick"], 0)
        self.assertEqual(state["stalled_ticks"], 25)

    def test_extension_bootstrap_state_preserves_zero_start_tick_without_reset(self) -> None:
        state = monitor.extension_bootstrap_next_state(
            {
                "start_tick": 0,
                "last_tick": 10,
                "last_progress_tick": 5,
                "extension_construction_site_count": 1,
                "extension_pending_build_progress": 2900,
                "stalled_ticks": 5,
            },
            current_tick=25,
            extension_construction_site_count=1,
            extension_pending_build_progress=2900,
        )

        self.assertEqual(state["start_tick"], 0)
        self.assertEqual(state["last_progress_tick"], 5)
        self.assertEqual(state["stalled_ticks"], 20)

    def test_extension_bootstrap_state_progress_and_reset_behavior_is_unchanged(self) -> None:
        progress_state = monitor.extension_bootstrap_next_state(
            {
                "start_tick": 100,
                "last_tick": 110,
                "last_progress_tick": 100,
                "extension_construction_site_count": 1,
                "extension_pending_build_progress": 2900,
                "stalled_ticks": 10,
            },
            current_tick=120,
            extension_construction_site_count=1,
            extension_pending_build_progress=2800,
        )
        reset_state = monitor.extension_bootstrap_next_state(
            {
                "start_tick": 100,
                "last_tick": 130,
                "last_progress_tick": 100,
                "extension_construction_site_count": 1,
                "extension_pending_build_progress": 2900,
                "stalled_ticks": 30,
            },
            current_tick=120,
            extension_construction_site_count=1,
            extension_pending_build_progress=2900,
        )

        self.assertEqual(progress_state["start_tick"], 100)
        self.assertEqual(progress_state["last_progress_tick"], 120)
        self.assertEqual(progress_state["stalled_ticks"], 0)
        self.assertEqual(reset_state["start_tick"], 120)
        self.assertEqual(reset_state["last_progress_tick"], 120)
        self.assertEqual(reset_state["stalled_ticks"], 0)

    def test_rcl2_zero_extension_active_site_tracks_bootstrap_without_p0(self) -> None:
        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "ctrl": {
                    "type": "controller",
                    "my": True,
                    "owner": {"username": "owner"},
                    "level": 2,
                    "x": 5,
                    "y": 36,
                },
                "site1": {
                    "type": "constructionSite",
                    "my": True,
                    "owner": {"username": "owner"},
                    "structureType": "extension",
                    "progress": 100,
                    "progressTotal": 3000,
                    "x": 24,
                    "y": 24,
                },
            },
            tick=1000,
        )

        emitted, suppressed, next_state = monitor.evaluate_room_alert(
            snapshot,
            {"baseline_established": True, "owner": "owner"},
            now=100,
            debounce_seconds=300,
        )

        self.assertEqual(suppressed, [])
        self.assertNotIn(monitor.EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND, [reason["kind"] for reason in emitted])
        state = next_state["rule_counts"][monitor.EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND]
        self.assertEqual(state["extension_construction_site_count"], 1)
        self.assertEqual(state["extension_pending_build_progress"], 2900)
        self.assertEqual(state["start_tick"], 1000)
        self.assertEqual(state["last_progress_tick"], 1000)
        self.assertEqual(state["stalled_ticks"], 0)

    def test_rcl2_zero_extension_recent_extension_progress_clears_stall_window(self) -> None:
        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "ctrl": {
                    "type": "controller",
                    "my": True,
                    "owner": {"username": "owner"},
                    "level": 2,
                    "x": 5,
                    "y": 36,
                },
                "site1": {
                    "type": "constructionSite",
                    "my": True,
                    "owner": {"username": "owner"},
                    "structureType": "extension",
                    "progress": 200,
                    "progressTotal": 3000,
                    "x": 24,
                    "y": 24,
                },
            },
            tick=1200,
        )
        previous_state = {
            "baseline_established": True,
            "owner": "owner",
            "rule_counts": {
                monitor.EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND: {
                    "start_tick": 1000,
                    "last_tick": 1100,
                    "last_progress_tick": 1000,
                    "extension_construction_site_count": 1,
                    "extension_pending_build_progress": 2900,
                    "stalled_ticks": 100,
                }
            },
        }

        emitted, suppressed, next_state = monitor.evaluate_room_alert(
            snapshot,
            previous_state,
            now=200,
            debounce_seconds=300,
        )

        self.assertEqual(suppressed, [])
        self.assertNotIn(monitor.EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND, [reason["kind"] for reason in emitted])
        state = next_state["rule_counts"][monitor.EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND]
        self.assertEqual(state["last_progress_tick"], 1200)
        self.assertEqual(state["extension_pending_build_progress"], 2800)
        self.assertEqual(state["extension_construction_site_count"], 1)
        self.assertEqual(state["stalled_ticks"], 0)

    def test_rcl2_zero_extension_missing_tick_preserves_bootstrap_state(self) -> None:
        snapshot = make_snapshot(
            {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "ctrl": {
                    "type": "controller",
                    "my": True,
                    "owner": {"username": "owner"},
                    "level": 2,
                    "x": 5,
                    "y": 36,
                },
                "site1": {
                    "type": "constructionSite",
                    "my": True,
                    "owner": {"username": "owner"},
                    "structureType": "extension",
                    "progress": 100,
                    "progressTotal": 3000,
                    "x": 24,
                    "y": 24,
                },
            },
            tick=None,
        )
        previous_bootstrap_state = {
            "start_tick": 1000,
            "last_tick": 1050,
            "last_progress_tick": 1000,
            "extension_construction_site_count": 1,
            "extension_pending_build_progress": 2900,
            "stalled_ticks": 50,
        }
        expected_bootstrap_state = copy.deepcopy(previous_bootstrap_state)

        emitted, suppressed, next_state = monitor.evaluate_room_alert(
            snapshot,
            {
                "baseline_established": True,
                "owner": "owner",
                "rule_counts": {monitor.EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND: previous_bootstrap_state},
            },
            now=200,
            debounce_seconds=300,
        )

        self.assertEqual(emitted, [])
        self.assertEqual(suppressed, [])
        self.assertEqual(
            next_state["rule_counts"][monitor.EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND],
            expected_bootstrap_state,
        )
        self.assertEqual(previous_bootstrap_state, expected_bootstrap_state)

    def test_rcl2_zero_extension_bootstrap_states_have_separate_debounce_signatures(self) -> None:
        base_objects = {
            "spawn1": {
                "type": "spawn",
                "my": True,
                "owner": {"username": "owner"},
                "x": 25,
                "y": 25,
                "hits": 5000,
                "hitsMax": 5000,
            },
            "ctrl": {
                "type": "controller",
                "my": True,
                "owner": {"username": "owner"},
                "level": 2,
                "x": 5,
                "y": 36,
            },
        }
        missing_site_snapshot = make_snapshot(base_objects, tick=1000)
        missing_site_reason = monitor.build_extension_count_zero_at_rcl_ge_2_reason(
            missing_site_snapshot.ref,
            monitor.compute_room_summary_metrics(missing_site_snapshot),
            reason="missing_extension_site",
        )
        stalled_objects = {
            **base_objects,
            "site1": {
                "type": "constructionSite",
                "my": True,
                "owner": {"username": "owner"},
                "structureType": "extension",
                "progress": 100,
                "progressTotal": 3000,
                "x": 24,
                "y": 24,
            },
        }
        threshold = monitor.EXTENSION_BOOTSTRAP_PROGRESS_STALL_TICKS
        stalled_snapshot = make_snapshot(stalled_objects, tick=1000 + threshold)

        emitted, suppressed, _next_state = monitor.evaluate_room_alert(
            stalled_snapshot,
            {
                "baseline_established": True,
                "owner": "owner",
                "alerts": {missing_site_reason["signature"]: 190},
                "rule_counts": {
                    monitor.EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND: {
                        "start_tick": 1000,
                        "last_tick": 1000,
                        "last_progress_tick": 1000,
                        "extension_construction_site_count": 1,
                        "extension_pending_build_progress": 2900,
                        "stalled_ticks": 0,
                    }
                },
            },
            now=200,
            debounce_seconds=300,
        )

        self.assertEqual(suppressed, [])
        reason = next(
            reason for reason in emitted if reason["kind"] == monitor.EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND
        )
        self.assertEqual(reason["bootstrapState"], "extension_bootstrap_stalled")
        self.assertNotEqual(reason["signature"], missing_site_reason["signature"])

    def test_rcl2_zero_extension_active_site_alerts_when_progress_stalls(self) -> None:
        threshold = monitor.EXTENSION_BOOTSTRAP_PROGRESS_STALL_TICKS
        self.assertGreaterEqual(threshold, 50)
        self.assertLessEqual(threshold, 200)
        base_objects = {
            "spawn1": {
                "type": "spawn",
                "my": True,
                "owner": {"username": "owner"},
                "x": 25,
                "y": 25,
                "hits": 5000,
                "hitsMax": 5000,
            },
            "ctrl": {
                "type": "controller",
                "my": True,
                "owner": {"username": "owner"},
                "level": 2,
                "x": 5,
                "y": 36,
            },
            "site1": {
                "type": "constructionSite",
                "my": True,
                "owner": {"username": "owner"},
                "structureType": "extension",
                "progress": 100,
                "progressTotal": 3000,
                "x": 24,
                "y": 24,
            },
        }
        first_snapshot = make_snapshot(base_objects, tick=1000)
        second_snapshot = make_snapshot(base_objects, tick=1000 + threshold)

        first_emitted, _first_suppressed, first_state = monitor.evaluate_room_alert(
            first_snapshot,
            {"baseline_established": True, "owner": "owner"},
            now=100,
            debounce_seconds=300,
        )
        self.assertNotIn(monitor.EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND, [reason["kind"] for reason in first_emitted])

        second_emitted, second_suppressed, second_state = monitor.evaluate_room_alert(
            second_snapshot,
            first_state,
            now=200,
            debounce_seconds=300,
        )

        self.assertEqual(second_suppressed, [])
        reason = next(
            reason for reason in second_emitted if reason["kind"] == monitor.EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND
        )
        self.assertEqual(reason["priority"], "P0")
        self.assertEqual(reason["bootstrapState"], "extension_bootstrap_stalled")
        self.assertEqual(reason["extensionConstructionSiteCount"], 1)
        self.assertEqual(reason["extensionPendingBuildProgress"], 2900)
        self.assertEqual(reason["stalledTicks"], threshold)
        self.assertEqual(
            second_state["rule_counts"][monitor.EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND]["stalled_ticks"],
            threshold,
        )

    def test_live_productive_energy_worker_assignment_gap_stays_active_with_other_tasks(self) -> None:
        runtime_room = {
            "roomName": "E29N55",
            "shard": "shardX",
            "workerCount": 3,
            "taskCounts": {"harvest": 1, "transfer": 1, "build": 0, "repair": 0, "upgrade": 1, "none": 0},
            "constructionSiteCount": 11,
            "constructionDeadlockTicks": 2,
            "resources": {
                "productiveEnergy": {
                    "assignedWorkerCount": 1,
                    "constructionSiteCount": 11,
                    "constructionDeadlockTicks": 2,
                    "buildBlockedReason": monitor.WORKER_ASSIGNMENT_GAP_BLOCKED_REASON,
                }
            },
        }

        reason, next_state = monitor.detect_worker_assignment_gap_sustained_reason(
            monitor.RoomRef(shard="shardX", room="E29N55"),
            runtime_room,
            make_worker_assignment_gap_metrics(),
            {"start_tick": 1000, "last_tick": 1099, "consecutive_ticks": 99},
            1101,
        )

        self.assertIsNotNone(reason)
        assert reason is not None
        self.assertEqual(reason["kind"], monitor.WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND)
        self.assertEqual(reason["buildBlockedReason"], monitor.WORKER_ASSIGNMENT_GAP_BLOCKED_REASON)
        self.assertEqual(next_state["consecutive_ticks"], 101)

    def test_room_only_console_summary_does_not_match_ambiguous_tracked_shards(self) -> None:
        payload = {
            "type": "runtime-summary",
            "tick": 995550,
            "rooms": [
                {
                    "roomName": "E29N55",
                    "workerCount": 3,
                    "taskCounts": {"harvest": 9, "transfer": 0, "build": 0, "repair": 0, "upgrade": 0, "none": 0},
                },
                {
                    "roomName": "E29N55",
                    "shard": "shardSeason",
                    "workerCount": 2,
                    "taskCounts": {"harvest": 2, "transfer": 0, "build": 0, "repair": 0, "upgrade": 0, "none": 0},
                },
            ],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            (runtime_dir / "runtime-summary-console-20260516T000000Z.log").write_text(
                "#runtime-summary " + json.dumps(payload) + "\n",
                encoding="utf-8",
            )
            warnings: list[str] = []

            runtime_rooms = monitor.load_latest_runtime_room_summaries(
                runtime_dir,
                [
                    monitor.RoomRef(shard="shardX", room="E29N55"),
                    monitor.RoomRef(shard="shardSeason", room="E29N55"),
                ],
                warnings,
            )

        self.assertEqual(warnings, [])
        self.assertNotIn("shardX/E29N55", runtime_rooms)
        self.assertEqual(runtime_rooms["shardSeason/E29N55"]["taskCounts"]["harvest"], 2)

    def test_room_only_console_summary_uses_overview_refs_for_forced_room_disambiguation(self) -> None:
        payload = {
            "type": "runtime-summary",
            "tick": 995550,
            "rooms": [
                {
                    "roomName": "E29N55",
                    "workerCount": 3,
                    "taskCounts": {"harvest": 9, "transfer": 0, "build": 0, "repair": 0, "upgrade": 0, "none": 0},
                }
            ],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            (runtime_dir / "runtime-summary-console-20260516T000000Z.log").write_text(
                "#runtime-summary " + json.dumps(payload) + "\n",
                encoding="utf-8",
            )
            warnings: list[str] = []

            runtime_rooms = monitor.load_latest_runtime_room_summaries(
                runtime_dir,
                [monitor.RoomRef(shard="shardX", room="E29N55")],
                warnings,
                disambiguation_refs=[
                    monitor.RoomRef(shard="shardX", room="E29N55"),
                    monitor.RoomRef(shard="shardSeason", room="E29N55"),
                ],
            )

        self.assertEqual(runtime_rooms, {})
        self.assertEqual(warnings, [])

    def test_room_only_console_summary_does_not_match_payload_cross_shard_collision(self) -> None:
        payload = {
            "type": "runtime-summary",
            "tick": 995550,
            "rooms": [
                {
                    "roomName": "E29N55",
                    "workerCount": 3,
                    "taskCounts": {"harvest": 9, "transfer": 0, "build": 0, "repair": 0, "upgrade": 0, "none": 0},
                },
                {
                    "roomName": "E29N55",
                    "shard": "shardSeason",
                    "workerCount": 2,
                    "taskCounts": {"harvest": 2, "transfer": 0, "build": 0, "repair": 0, "upgrade": 0, "none": 0},
                },
            ],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            (runtime_dir / "runtime-summary-console-20260516T000000Z.log").write_text(
                "#runtime-summary " + json.dumps(payload) + "\n",
                encoding="utf-8",
            )
            warnings: list[str] = []

            runtime_rooms = monitor.load_latest_runtime_room_summaries(
                runtime_dir,
                [monitor.RoomRef(shard="shardX", room="E29N55")],
                warnings,
            )

        self.assertEqual(runtime_rooms, {})
        self.assertEqual(warnings, [])

    def test_runtime_summary_loader_ignores_behavior_only_pathing_totals(self) -> None:
        payload = {
            "type": "runtime-summary",
            "tick": 265635,
            "rooms": [
                {
                    "roomName": "E26S49",
                    "shard": "shardX",
                    "behavior": {"totals": {"pathFindingFailures": 0, "destinationBlocked": 0}},
                }
            ],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            (runtime_dir / "runtime-summary-monitor-20260513T000000Z.log").write_text(
                "#runtime-summary " + json.dumps(payload) + "\n",
                encoding="utf-8",
            )
            warnings: list[str] = []

            result = monitor.load_latest_runtime_room_summaries(
                runtime_dir,
                [monitor.RoomRef(shard="shardX", room="E26S49")],
                warnings,
            )

        self.assertEqual(result, {})
        self.assertEqual(warnings, [])



if __name__ == "__main__":
    unittest.main()
