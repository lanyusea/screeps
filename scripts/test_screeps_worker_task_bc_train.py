#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import screeps_worker_task_bc_train as trainer


def runtime_line(payload: dict[str, object]) -> str:
    return f"#runtime-summary {json.dumps(payload, sort_keys=True)}\n"


def read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


class WorkerTaskBehavioralCloningTrainTest(unittest.TestCase):
    def test_extracts_behavior_samples_and_trains_shadow_policy(self) -> None:
        payload = {
            "type": "runtime-summary",
            "tick": 100,
            "rooms": [
                {
                    "roomName": "W1N1",
                    "behavior": {
                        "workerTaskPolicy": {
                            "liveEffect": False,
                            "samples": [
                                make_sample("HarvesterA", "harvest", "source1", 0, 100),
                                make_sample("HarvesterB", "harvest", "source2", 0, 101),
                                make_sample("CarrierA", "transfer", "spawn1", 50, 102),
                                make_sample("CarrierB", "transfer", "spawn1", 50, 103),
                            ],
                        }
                    },
                }
            ],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "runtime.log"
            artifact.write_text(runtime_line(payload), encoding="utf-8")
            out_dir = root / "bc"

            summary = trainer.train_policy(
                [str(artifact)],
                out_dir,
                run_id="test-run",
                eval_ratio_value=0,
                max_depth=2,
                min_samples_split=2,
            )
            model = read_json(out_dir / "test-run" / "worker_task_policy.json")
            report = read_json(out_dir / "test-run" / "evaluation_report.json")

        self.assertTrue(summary["ok"])
        self.assertEqual(summary["sampleCount"], 4)
        self.assertEqual(summary["actionMatchRate"], 1.0)
        self.assertTrue(summary["passesFidelityGate"])
        self.assertFalse(model["liveEffect"])
        self.assertEqual(model["type"], trainer.MODEL_TYPE)
        self.assertEqual(model["root"]["type"], "branch")
        self.assertFalse(report["liveEffect"])
        self.assertEqual(report["acceptance"]["actionMatchRate"], 1.0)

    def test_skips_unsupported_or_live_effect_samples(self) -> None:
        supported = make_sample("Builder", "build", "site1", 50, 10)
        unsupported = make_sample("Withdrawer", "withdraw", "container1", 0, 11)
        live_effect = make_sample("Carrier", "transfer", "spawn1", 50, 12)
        live_effect["liveEffect"] = True
        payload = {
            "type": "runtime-summary",
            "tick": 12,
            "rooms": [
                {
                    "roomName": "W1N1",
                    "behavior": {
                        "workerTaskPolicy": {
                            "samples": [supported, unsupported, live_effect],
                        }
                    },
                }
            ],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            artifact = Path(temp_dir) / "runtime.log"
            artifact.write_text(runtime_line(payload), encoding="utf-8")
            samples = trainer.extract_behavior_samples([str(artifact)])

        self.assertEqual([sample.action for sample in samples], ["build"])


def make_sample(
    creep_name: str,
    action: str,
    target_id: str,
    carried_energy: int,
    tick: int,
) -> dict[str, object]:
    return {
        "type": "workerTaskBehavior",
        "schemaVersion": 1,
        "tick": tick,
        "creepName": creep_name,
        "policyId": "heuristic.worker-task.v1",
        "liveEffect": False,
        "state": {
            "roomName": "W1N1",
            "carriedEnergy": carried_energy,
            "freeCapacity": max(0, 50 - carried_energy),
            "energyCapacity": 50,
            "energyLoadRatio": carried_energy / 50,
            "currentTaskCode": 0,
            "spawnExtensionNeedCount": 1 if action == "transfer" else 0,
            "constructionSiteCount": 1 if action == "build" else 0,
            "sourceCount": 2,
            "hasContainerEnergy": False,
            "containerEnergyAvailable": 0,
            "droppedEnergyAvailable": 0,
            "nearbyRoadCount": 0,
            "nearbyContainerCount": 0,
            "roadCoverage": 0,
            "hostileCreepCount": 0,
        },
        "action": {"type": action, "targetId": target_id},
    }


if __name__ == "__main__":
    unittest.main()
