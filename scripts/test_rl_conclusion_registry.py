#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock


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
        self.assertEqual(merged["summary"]["countsByStatus"]["ACTIONED"], 1)
        self.assertEqual(merged["summary"]["countsByStatus"]["CLOSED"], 1)
        self.assertEqual(merged["summary"]["countsByStatus"]["OPEN"], 1)

    def test_merge_prunes_omitted_records_owned_by_current_owner_only(self) -> None:
        existing = {
            "schemaVersion": 1,
            "registryType": "rl-conclusion-registry",
            "conclusions": {
                "E1-STALE-OMITTED": {
                    "conclusionId": "E1-STALE-OMITTED",
                    "ownerCron": "d6cff532edd4",
                    "status": "OPEN",
                    "statement": "Previous E1 conditional conclusion no longer emitted.",
                },
                "LOOP-B-OMITTED": {
                    "conclusionId": "LOOP-B-OMITTED",
                    "ownerCron": "01609968392a",
                    "status": "ACTIONED",
                    "statement": "Different owner conclusion remains active.",
                },
                "LEGACY-UNOWNED-OMITTED": {
                    "conclusionId": "LEGACY-UNOWNED-OMITTED",
                    "status": "OPEN",
                    "statement": "Legacy unowned conclusion is preserved until explicitly claimed.",
                },
            },
        }

        merged = registry.merge_registry_payload(
            existing,
            [
                {
                    "conclusionId": "E1-GATE-STATUS",
                    "status": "CLOSED",
                    "statement": "Current E1 gate passed.",
                },
            ],
            owner_cron="d6cff532edd4",
            updated_at="2026-05-23T00:00:00Z",
        )

        conclusions = merged["conclusions"]
        self.assertNotIn("E1-STALE-OMITTED", conclusions)
        self.assertEqual(conclusions["LOOP-B-OMITTED"]["ownerCron"], "01609968392a")
        self.assertNotIn("ownerCron", conclusions["LEGACY-UNOWNED-OMITTED"])
        self.assertEqual(conclusions["E1-GATE-STATUS"]["ownerCron"], "d6cff532edd4")
        self.assertEqual(merged["summary"]["total"], 3)

    def test_merge_allows_updating_legacy_records_missing_owner_cron(self) -> None:
        existing = {
            "schemaVersion": 1,
            "registryType": "rl-conclusion-registry",
            "conclusions": {
                "E1-GATE-STATUS": {
                    "conclusionId": "E1-GATE-STATUS",
                    "status": "OPEN",
                    "statement": "Legacy E1 gate failed before ownerCron existed.",
                },
            },
        }

        merged = registry.merge_registry_payload(
            existing,
            [
                {
                    "conclusionId": "E1-GATE-STATUS",
                    "status": "CLOSED",
                    "statement": "Current E1 gate passed.",
                },
            ],
            owner_cron="d6cff532edd4",
            updated_at="2026-05-23T00:00:00Z",
        )

        conclusion = merged["conclusions"]["E1-GATE-STATUS"]
        self.assertEqual(conclusion["status"], "CLOSED")
        self.assertEqual(conclusion["statement"], "Current E1 gate passed.")
        self.assertEqual(conclusion["ownerCron"], "d6cff532edd4")
        self.assertEqual(merged["summary"]["closedThisWindow"], 1)

    def test_summary_counts_missing_or_invalid_status_as_unknown(self) -> None:
        merged = registry.merge_registry_payload(
            {},
            [
                {"conclusionId": "MISSING-STATUS", "statement": "Missing status."},
                {"conclusionId": "INVALID-STATUS", "status": "deferred", "statement": "Invalid status."},
            ],
            owner_cron="d6cff532edd4",
            updated_at="2026-05-23T00:00:00Z",
        )

        self.assertEqual(merged["summary"]["total"], 2)
        self.assertEqual(merged["summary"]["unknown"], 2)
        self.assertEqual(merged["summary"]["countsByStatus"]["UNKNOWN"], 1)
        self.assertEqual(merged["summary"]["countsByStatus"]["DEFERRED"], 1)

    def test_normalize_conclusions_rejects_duplicate_conclusion_ids(self) -> None:
        with self.assertRaisesRegex(registry.ConclusionRegistryError, "DUPLICATE-ID"):
            registry.normalize_conclusions(
                [
                    {"conclusionId": "DUPLICATE-ID", "status": "OPEN"},
                    {"conclusionId": "DUPLICATE-ID", "status": "CLOSED"},
                ]
            )

        with self.assertRaisesRegex(registry.ConclusionRegistryError, "DUPLICATE-ID"):
            registry.normalize_conclusions(
                {
                    "FIRST-KEY": {"conclusionId": "DUPLICATE-ID", "status": "OPEN"},
                    "SECOND-KEY": {"conclusionId": "DUPLICATE-ID", "status": "CLOSED"},
                }
            )

    @unittest.skipIf(os.name == "nt", "POSIX file mode preservation test")
    def test_merge_registry_file_preserves_existing_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "conclusion-registry.json"
            path.write_text(
                registry.canonical_json(
                    {
                        "schemaVersion": 1,
                        "registryType": "rl-conclusion-registry",
                        "conclusions": {},
                    }
                ),
                encoding="utf-8",
            )
            os.chmod(path, 0o640)

            registry.merge_registry_file(
                path,
                [{"conclusionId": "E1-GATE-STATUS", "status": "CLOSED", "statement": "E1 passed."}],
                owner_cron="d6cff532edd4",
                updated_at="2026-05-23T00:00:00Z",
            )

            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o640)

    def test_merge_registry_file_uses_exclusive_sidecar_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "conclusion-registry.json"

            with mock.patch.object(registry.fcntl, "flock", wraps=registry.fcntl.flock) as flock:
                registry.merge_registry_file(
                    path,
                    [{"conclusionId": "E1-GATE-STATUS", "status": "CLOSED", "statement": "E1 passed."}],
                    owner_cron="d6cff532edd4",
                    updated_at="2026-05-23T00:00:00Z",
                )

            self.assertEqual(
                [call.args[1] for call in flock.call_args_list],
                [registry.fcntl.LOCK_EX, registry.fcntl.LOCK_UN],
            )

    def test_merge_registry_file_normalizes_legacy_list_and_recomputes_summary(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "conclusion-registry.json"
            path.write_text(
                registry.canonical_json(
                    {
                        "schemaVersion": 1,
                        "registryType": "rl-conclusion-registry",
                        "lastUpdatedAt": "2026-05-24T04:00:00Z",
                        "updatedBy": "legacy-writer",
                        "summary": {
                            "total": 2,
                            "open": 99,
                            "actioned": 0,
                            "validating": 0,
                            "closedThisWindow": 12,
                            "staleOrEscalated": 0,
                            "countsByStatus": {"ACTIONED": 2, "OPEN": 2, "STALE": 5},
                            "lastUpdateReason": "stale PR state from a previous writer",
                        },
                        "conclusions": [
                            {
                                "conclusionId": "LEGACY-UNOWNED-OPEN",
                                "status": "OPEN",
                                "statement": "Unowned legacy conclusion must survive E1 writes.",
                            },
                            {
                                "conclusionId": "LOOP-B-ACTIONED",
                                "ownerCron": "01609968392a",
                                "status": "ACTIONED",
                                "statement": "Loop B action still needs sustained-output validation.",
                            },
                            {
                                "conclusionId": "LOOP-A-STALE",
                                "ownerCron": "loop-a-policy-gradient",
                                "status": "STALE",
                                "statement": "Loop A conclusion remains stale until refreshed.",
                            },
                            {
                                "conclusionId": "E1-GATE-STATUS",
                                "ownerCron": "d6cff532edd4",
                                "status": "OPEN",
                                "statement": "Previous E1 gate failed.",
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )

            merged = registry.merge_registry_file(
                path,
                [
                    {
                        "conclusionId": "E1-GATE-STATUS",
                        "status": "CLOSED",
                        "statement": "Current E1 gate passed.",
                    },
                    {
                        "conclusionId": "E1-SUSTAINED-OUTPUT",
                        "status": "VALIDATING",
                        "statement": "E1 closure is waiting for sustained-output evidence.",
                    },
                ],
                owner_cron="d6cff532edd4",
                updated_at="2026-05-24T05:00:00Z",
            )
            saved = read_json(path)

        self.assertEqual(saved, merged)
        self.assertIsInstance(saved["conclusions"], dict)
        self.assertEqual(saved["conclusions"]["LEGACY-UNOWNED-OPEN"]["status"], "OPEN")
        self.assertNotIn("ownerCron", saved["conclusions"]["LEGACY-UNOWNED-OPEN"])
        self.assertEqual(saved["conclusions"]["LOOP-B-ACTIONED"]["ownerCron"], "01609968392a")
        self.assertEqual(saved["conclusions"]["LOOP-A-STALE"]["ownerCron"], "loop-a-policy-gradient")
        self.assertEqual(saved["conclusions"]["E1-GATE-STATUS"]["ownerCron"], "d6cff532edd4")
        self.assertEqual(saved["summary"]["total"], len(saved["conclusions"]))
        self.assertEqual(saved["summary"]["open"], 1)
        self.assertEqual(saved["summary"]["actioned"], 1)
        self.assertEqual(saved["summary"]["validating"], 1)
        self.assertEqual(saved["summary"]["closedThisWindow"], 1)
        self.assertEqual(saved["summary"]["staleOrEscalated"], 1)
        self.assertNotIn("lastUpdateReason", saved["summary"])
        self.assertEqual(
            saved["summary"]["countsByStatus"],
            {
                "ACTIONED": 1,
                "CLOSED": 1,
                "ESCALATED": 0,
                "OPEN": 1,
                "STALE": 1,
                "VALIDATING": 1,
            },
        )

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
