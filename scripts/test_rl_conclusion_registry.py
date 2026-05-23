#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


sys.path.insert(0, str(Path(__file__).parent))

import rl_conclusion_registry as registry


JsonObject = dict[str, Any]


def read_json(path: Path) -> JsonObject:
    return json.loads(path.read_text(encoding="utf-8"))


class RlConclusionRegistryTest(unittest.TestCase):
    def test_merge_preserves_non_owner_records_and_updates_e1_records(self) -> None:
        existing = {
            "schemaVersion": 1,
            "registryType": "rl-conclusion-registry",
            "lastUpdatedAt": "2026-05-22T22:00:00Z",
            "updatedBy": "steward",
            "conclusions": {
                "LOOP-B-OPEN": {
                    "conclusionId": "LOOP-B-OPEN",
                    "ownerCron": "01609968392a",
                    "status": "ACTIONED",
                    "statement": "Loop B conclusion remains unresolved.",
                },
                "E1-GATE-STATUS": {
                    "conclusionId": "E1-GATE-STATUS",
                    "ownerCron": "d6cff532edd4",
                    "status": "OPEN",
                    "statement": "Old E1 gate failed.",
                },
            },
        }

        merged = registry.merge_registry_payload(
            existing,
            [
                {
                    "conclusionId": "E1-GATE-STATUS",
                    "status": "CLOSED",
                    "statement": "New E1 gate passed.",
                },
                {
                    "conclusionId": "E1-EVAL-SAMPLE-LIMITED",
                    "status": "OPEN",
                    "statement": "Eval sample remains limited.",
                },
            ],
            owner_cron="d6cff532edd4",
            updated_at="2026-05-23T00:00:00Z",
            updated_by="d6cff532edd4",
        )

        conclusions = merged["conclusions"]
        self.assertEqual(conclusions["LOOP-B-OPEN"]["statement"], "Loop B conclusion remains unresolved.")
        self.assertEqual(conclusions["LOOP-B-OPEN"]["ownerCron"], "01609968392a")
        self.assertEqual(conclusions["E1-GATE-STATUS"]["status"], "CLOSED")
        self.assertEqual(conclusions["E1-GATE-STATUS"]["ownerCron"], "d6cff532edd4")
        self.assertEqual(conclusions["E1-EVAL-SAMPLE-LIMITED"]["ownerCron"], "d6cff532edd4")
        self.assertEqual(merged["summary"]["total"], 3)
        self.assertEqual(merged["summary"]["new"], 1)
        self.assertEqual(merged["summary"]["closedThisWindow"], 1)
        self.assertEqual(merged["summary"]["actioned"], 1)

    def test_merge_rejects_cross_owner_conclusion_id_collision_without_rewriting_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "conclusion-registry.json"
            original = {
                "schemaVersion": 1,
                "registryType": "rl-conclusion-registry",
                "conclusions": {
                    "SHARED-ID": {
                        "conclusionId": "SHARED-ID",
                        "ownerCron": "01609968392a",
                        "status": "OPEN",
                        "statement": "Loop B owns this ID.",
                    }
                },
            }
            path.write_text(registry.canonical_json(original), encoding="utf-8")

            with self.assertRaises(registry.ConclusionRegistryError):
                registry.merge_registry_file(
                    path,
                    [{"conclusionId": "SHARED-ID", "status": "CLOSED", "statement": "E1 collision."}],
                    owner_cron="d6cff532edd4",
                    updated_at="2026-05-23T00:00:00Z",
                )

            self.assertEqual(read_json(path), original)


if __name__ == "__main__":
    unittest.main()
