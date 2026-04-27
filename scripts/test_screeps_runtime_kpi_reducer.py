#!/usr/bin/env python3
from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import screeps_runtime_kpi_reducer as reducer


def runtime_line(payload: dict[str, object]) -> str:
    return f"#runtime-summary {json.dumps(payload, sort_keys=True)}\n"


class RuntimeKpiReducerTest(unittest.TestCase):
    def test_aggregates_runtime_summary_kpis_and_ignores_bad_lines(self) -> None:
        first = {
            "type": "runtime-summary",
            "tick": 100,
            "rooms": [
                {
                    "roomName": "W1N1",
                    "controller": {"level": 2, "progress": 1000, "progressTotal": 45000, "ticksToDowngrade": 15000},
                    "resources": {
                        "storedEnergy": 175,
                        "workerCarriedEnergy": 60,
                        "droppedEnergy": 25,
                        "sourceCount": 2,
                        "events": {"harvestedEnergy": 10, "transferredEnergy": 5},
                    },
                    "combat": {
                        "hostileCreepCount": 1,
                        "hostileStructureCount": 1,
                        "events": {
                            "attackCount": 1,
                            "attackDamage": 30,
                            "objectDestroyedCount": 1,
                            "creepDestroyedCount": 1,
                        },
                    },
                }
            ],
        }
        latest = {
            "type": "runtime-summary",
            "tick": 120,
            "rooms": [
                {
                    "roomName": "W1N1",
                    "controller": {"level": 2, "progress": 1300, "progressTotal": 45000, "ticksToDowngrade": 14950},
                    "resources": {
                        "storedEnergy": 210,
                        "workerCarriedEnergy": 20,
                        "droppedEnergy": 5,
                        "sourceCount": 2,
                        "events": {"harvestedEnergy": 7, "transferredEnergy": 3},
                    },
                    "combat": {"hostileCreepCount": 0, "hostileStructureCount": 1},
                }
            ],
        }

        report = reducer.reduce_runtime_kpis(
            [
                "noise before\n",
                runtime_line(first),
                "#runtime-summary {not json}\n",
                runtime_line(latest),
                '{"type":"not-runtime-summary"}\n',
            ]
        )

        self.assertEqual(report["input"], {
            "lineCount": 5,
            "runtimeSummaryCount": 2,
            "ignoredLineCount": 3,
            "malformedRuntimeSummaryCount": 1,
        })
        self.assertEqual(report["window"], {"firstTick": 100, "latestTick": 120})
        self.assertEqual(report["territory"]["ownedRooms"], {
            "status": "observed",
            "latest": ["W1N1"],
            "latestCount": 1,
            "deltaCount": 0,
            "gained": [],
            "lost": [],
        })
        self.assertEqual(
            report["territory"]["controllers"]["rooms"]["W1N1"],
            {
                "status": "observed",
                "latest": {"level": 2, "progress": 1300, "progressTotal": 45000, "ticksToDowngrade": 14950},
                "delta": {"level": 0, "progress": 300, "progressTotal": 0, "ticksToDowngrade": -50},
            },
        )
        self.assertEqual(report["resources"]["totals"]["latest"], {
            "storedEnergy": 210,
            "workerCarriedEnergy": 20,
            "droppedEnergy": 5,
            "sourceCount": 2,
        })
        self.assertEqual(report["resources"]["totals"]["delta"], {
            "storedEnergy": 35,
            "workerCarriedEnergy": -40,
            "droppedEnergy": -20,
            "sourceCount": 0,
        })
        self.assertEqual(report["resources"]["eventDeltas"], {
            "status": "observed",
            "harvestedEnergy": 17,
            "transferredEnergy": 8,
        })
        self.assertEqual(report["combat"]["totals"]["latest"], {
            "hostileCreepCount": 0,
            "hostileStructureCount": 1,
        })
        self.assertEqual(report["combat"]["eventDeltas"], {
            "status": "observed",
            "attackCount": 1,
            "attackDamage": 30,
            "objectDestroyedCount": 1,
            "creepDestroyedCount": 1,
        })

    def test_rejects_runtime_summary_lines_with_trailing_garbage(self) -> None:
        report = reducer.reduce_runtime_kpis(['#runtime-summary {"type":"runtime-summary"} garbage\n'])

        self.assertEqual(report["input"], {
            "lineCount": 1,
            "runtimeSummaryCount": 0,
            "ignoredLineCount": 1,
            "malformedRuntimeSummaryCount": 1,
        })

    def test_marks_missing_kpi_sections_as_not_instrumented(self) -> None:
        report = reducer.reduce_runtime_kpis(
            [
                runtime_line(
                    {
                        "type": "runtime-summary",
                        "tick": 80,
                        "rooms": [{"roomName": "W1N1", "energyAvailable": 250}],
                    }
                )
            ]
        )

        self.assertEqual(report["territory"]["ownedRooms"]["latest"], ["W1N1"])
        self.assertEqual(report["territory"]["controllers"]["status"], "not instrumented")
        self.assertEqual(report["territory"]["controllers"]["rooms"]["W1N1"]["message"], "not instrumented")
        self.assertEqual(report["resources"]["status"], "not instrumented")
        self.assertEqual(report["combat"]["status"], "not instrumented")

    def test_event_deltas_include_rooms_seen_across_the_window(self) -> None:
        first = {
            "type": "runtime-summary",
            "tick": 10,
            "rooms": [
                {
                    "roomName": "W1N1",
                    "resources": {"storedEnergy": 1, "workerCarriedEnergy": 0, "droppedEnergy": 0, "sourceCount": 1},
                    "combat": {"hostileCreepCount": 0, "hostileStructureCount": 0},
                },
                {
                    "roomName": "W2N2",
                    "resources": {
                        "storedEnergy": 2,
                        "workerCarriedEnergy": 0,
                        "droppedEnergy": 0,
                        "sourceCount": 1,
                        "events": {"harvestedEnergy": 4, "transferredEnergy": 3},
                    },
                    "combat": {
                        "hostileCreepCount": 1,
                        "hostileStructureCount": 0,
                        "events": {"attackCount": 2, "attackDamage": 9, "objectDestroyedCount": 1, "creepDestroyedCount": 0},
                    },
                },
            ],
        }
        latest = {
            "type": "runtime-summary",
            "tick": 20,
            "rooms": [
                {
                    "roomName": "W1N1",
                    "resources": {"storedEnergy": 5, "workerCarriedEnergy": 0, "droppedEnergy": 0, "sourceCount": 1},
                    "combat": {"hostileCreepCount": 0, "hostileStructureCount": 0},
                }
            ],
        }

        report = reducer.reduce_runtime_kpis([runtime_line(first), runtime_line(latest)])

        self.assertEqual(report["territory"]["ownedRooms"]["lost"], ["W2N2"])
        self.assertEqual(report["resources"]["eventDeltas"], {
            "status": "observed",
            "harvestedEnergy": 4,
            "transferredEnergy": 3,
        })
        self.assertEqual(report["combat"]["eventDeltas"], {
            "status": "observed",
            "attackCount": 2,
            "attackDamage": 9,
            "objectDestroyedCount": 1,
            "creepDestroyedCount": 0,
        })

    def test_resource_total_delta_includes_lost_room_values(self) -> None:
        first = {
            "type": "runtime-summary",
            "tick": 10,
            "rooms": [
                {
                    "roomName": "W2N2",
                    "resources": {"storedEnergy": 100, "workerCarriedEnergy": 7, "droppedEnergy": 3, "sourceCount": 2},
                },
            ],
        }
        latest = {
            "type": "runtime-summary",
            "tick": 20,
            "rooms": [],
        }

        report = reducer.reduce_runtime_kpis([runtime_line(first), runtime_line(latest)])

        self.assertEqual(report["territory"]["ownedRooms"]["lost"], ["W2N2"])
        self.assertEqual(report["resources"]["status"], "observed")
        self.assertEqual(report["resources"]["totals"]["latest"], {
            "storedEnergy": 0,
            "workerCarriedEnergy": 0,
            "droppedEnergy": 0,
            "sourceCount": 0,
        })
        self.assertEqual(report["resources"]["totals"]["delta"], {
            "storedEnergy": -100,
            "workerCarriedEnergy": -7,
            "droppedEnergy": -3,
            "sourceCount": -2,
        })

    def test_reads_files_and_stdin_marker_and_renders_deterministic_json(self) -> None:
        file_payload = {
            "type": "runtime-summary",
            "tick": 10,
            "rooms": [{"roomName": "W1N1", "resources": {"storedEnergy": 1, "workerCarriedEnergy": 2, "droppedEnergy": 3, "sourceCount": 1}}],
        }
        stdin_payload = {
            "type": "runtime-summary",
            "tick": 20,
            "rooms": [{"roomName": "W1N1", "resources": {"storedEnergy": 5, "workerCarriedEnergy": 7, "droppedEnergy": 0, "sourceCount": 1}}],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "runtime.log"
            path.write_text(runtime_line(file_payload), encoding="utf-8")
            report = reducer.reduce_runtime_kpis(
                reducer.iter_input_lines([str(path), "-"], stdin=io.StringIO(runtime_line(stdin_payload)))
            )

        rendered = reducer.render_json(report)
        self.assertEqual(json.loads(rendered), report)
        self.assertEqual(report["window"], {"firstTick": 10, "latestTick": 20})
        self.assertEqual(report["resources"]["totals"]["latest"]["storedEnergy"], 5)
        self.assertEqual(report["resources"]["totals"]["delta"]["storedEnergy"], 4)

    def test_human_mode_is_short_and_marks_unobserved_events(self) -> None:
        report = reducer.reduce_runtime_kpis(
            [
                runtime_line(
                    {
                        "type": "runtime-summary",
                        "tick": 20,
                        "rooms": [
                            {
                                "roomName": "W1N1",
                                "controller": {"level": 2, "progress": 10, "progressTotal": 45000, "ticksToDowngrade": 1000},
                                "resources": {"storedEnergy": 20, "workerCarriedEnergy": 1, "droppedEnergy": 0, "sourceCount": 2},
                                "combat": {"hostileCreepCount": 0, "hostileStructureCount": 0},
                            }
                        ],
                    }
                )
            ]
        )

        human = reducer.render_human(report)

        self.assertIn("territory: 1 owned room(s): W1N1", human)
        self.assertIn("controller W1N1: RCL 2 progress 10/45000", human)
        self.assertIn("resources:", human)
        self.assertIn("events not observed", human)


if __name__ == "__main__":
    unittest.main()
