#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import copy
import json
import sys
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
    "rooms": ["shardX/E48S28"],
    "warnings": [],
}

HOSTILE_ALERT_FIXTURE = {
    "ok": True,
    "mode": "alert",
    "alert": True,
    "reasons": [
        {
            "kind": "hostile_creep",
            "room": "shardX/E48S28",
            "object_id": "hostile-1",
            "owner": "Invader",
            "x": 20,
            "y": 21,
            "message": "hostile creep visible: Invader at 20,21",
        }
    ],
    "rooms": ["shardX/E48S28"],
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
        ref=monitor.RoomRef("shardX", "E48S28"),
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
                "rooms": ["shardX/E48S28"],
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

        self.assertEqual(emitted[0]["kind"], "structure_damage")
        self.assertEqual(emitted[0]["structure_type"], "factory")

        report = monitor.build_tactical_response_report(
            {
                "ok": True,
                "mode": "alert",
                "alert": True,
                "reasons": emitted,
                "rooms": ["shardX/E48S28"],
            }
        )

        self.assertEqual(report["severity"], "critical")
        self.assertEqual(report["categories"], ["owned_structure_damage"])
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


if __name__ == "__main__":
    unittest.main()
