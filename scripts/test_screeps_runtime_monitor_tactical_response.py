#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("screeps-runtime-monitor.py")
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


def make_snapshot(objects: dict[str, dict[str, object]]) -> monitor.RoomSnapshot:
    return monitor.RoomSnapshot(
        ref=monitor.RoomRef("shardX", "E26S49"),
        terrain="0" * monitor.TERRAIN_CELLS,
        objects=monitor.normalize_objects(objects),
        tick=1,
        owner="owner",
        info={},
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
        self.assertEqual(payload["rooms"][0]["rclLevel"], 3)
        self.assertEqual(payload["rooms"][0]["storedEnergy"], 355)
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
                    }
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
