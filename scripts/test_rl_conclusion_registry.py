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

    def test_summary_surfaces_high_priority_stale_backlog_gate(self) -> None:
        records = {
            f"P0-STALE-{index:02d}": {
                "conclusionId": f"P0-STALE-{index:02d}",
                "status": "STALE",
                "severity": "P0",
                "lastSeenAt": f"2026-05-2{index % 10}T00:00:00Z",
            }
            for index in range(11)
        }
        records["P1-OPEN"] = {
            "conclusionId": "P1-OPEN",
            "status": "OPEN",
            "severity": "P1",
            "lastSeenAt": "2026-05-31T00:00:00Z",
        }
        records["P2-STALE"] = {
            "conclusionId": "P2-STALE",
            "status": "STALE",
            "severity": "P2",
            "lastSeenAt": "2026-05-31T00:00:00Z",
        }

        gate = registry.summarize_conclusions(records)["actionableIssueGate"]

        self.assertEqual(gate["name"], "p0_p1_stale_conclusion_backlog")
        self.assertEqual(gate["status"], "ACTION_REQUIRED")
        self.assertTrue(gate["thresholdExceeded"])
        self.assertEqual(gate["threshold"], 10)
        self.assertEqual(gate["staleHighPriorityCount"], 11)
        self.assertEqual(gate["openHighPriorityCount"], 1)
        self.assertEqual(gate["staleBySeverity"], {"P0": 11, "P1": 0})
        self.assertEqual(gate["openBySeverity"], {"P0": 0, "P1": 1})
        self.assertEqual(gate["highestPriorityConclusionIds"][0], "P0-STALE-00")
        self.assertNotIn("P2-STALE", gate["highestPriorityConclusionIds"])
        self.assertEqual(
            gate["recommendedAction"],
            "create_or_update_aggregate_rl_conclusion_closure_issue_and_project_evidence",
        )
        self.assertEqual(gate["aggregateRoutingIssue"], "#1543")
        self.assertEqual(gate["aggregateRoutingIssueNumber"], 1543)
        self.assertEqual(gate["minimumStaleTransitionsPerStewardCycle"], 3)
        self.assertEqual(gate["requiredStaleTransition"], "STALE -> ACTIONED/CLOSED")
        self.assertIn("11 P0/P1 STALE conclusions exceed threshold 10", gate["evidence"])

    def test_summary_gate_ok_when_high_priority_stale_count_within_threshold(self) -> None:
        records = {
            f"P1-STALE-{index:02d}": {
                "conclusionId": f"P1-STALE-{index:02d}",
                "status": "STALE",
                "severity": "P1",
            }
            for index in range(10)
        }

        gate = registry.summarize_conclusions(records)["actionableIssueGate"]

        self.assertEqual(gate["status"], "OK")
        self.assertFalse(gate["thresholdExceeded"])
        self.assertEqual(gate["staleHighPriorityCount"], 10)
        self.assertNotIn("recommendedAction", gate)
        self.assertNotIn("evidence", gate)

    def test_action_plan_handles_object_registry_and_routes_issue_1543(self) -> None:
        payload = {
            "schemaVersion": 1,
            "registryType": "rl-conclusion-registry",
            "conclusions": {
                "P1-CURRENT-BLOCKER": {
                    "conclusionId": "P1-CURRENT-BLOCKER",
                    "status": "OPEN",
                    "severity": "P1",
                    "category": "runtime-evidence",
                    "linkedIssues": [1542, "#1540"],
                    "requiredLandingEvidence": {"pr": "#1500"},
                    "nextVerification": "rerun steward after merge evidence lands",
                    "lastSeenAt": "2026-05-31T00:00:00Z",
                    "statement": "Runtime policy still needs landing evidence.",
                },
                "P0-SUPERSEDED": {
                    "conclusionId": "P0-SUPERSEDED",
                    "status": "STALE",
                    "severity": "P0",
                    "category": "policy-stale",
                    "lastSeenAt": "2026-05-25T00:00:00Z",
                    "statement": "SUPERSEDED by the current rollout path.",
                },
                "P2-IGNORED": {
                    "conclusionId": "P2-IGNORED",
                    "status": "STALE",
                    "severity": "P2",
                    "category": "policy-stale",
                },
                "P0-CLOSED-IGNORED": {
                    "conclusionId": "P0-CLOSED-IGNORED",
                    "status": "CLOSED",
                    "severity": "P0",
                    "category": "runtime-evidence",
                },
            },
        }

        plan = registry.build_stale_conclusion_action_plan(payload)

        self.assertEqual(plan["aggregateRoutingIssue"], "#1543")
        self.assertEqual(plan["aggregateRoutingIssueNumber"], 1543)
        self.assertEqual(plan["candidateFilter"], {"statuses": ["OPEN", "STALE"], "severities": ["P0", "P1"]})
        self.assertEqual(plan["totalActionableCount"], 2)
        self.assertEqual(plan["staleDecisionBacklogCount"], 1)
        self.assertEqual(plan["countsByStatus"], {"OPEN": 1, "STALE": 1})
        self.assertEqual(plan["countsBySeverity"], {"P0": 1, "P1": 1})
        self.assertEqual(plan["countsByCategory"], {"policy-stale": 1, "runtime-evidence": 1})
        self.assertEqual(plan["highestPriorityConclusionIds"], ["P0-SUPERSEDED", "P1-CURRENT-BLOCKER"])
        self.assertEqual(
            plan["recommendedNextAction"],
            {
                "action": "triage_stale_conclusions_via_aggregate_routing_issue",
                "routingIssue": "#1543",
                "routingIssueNumber": 1543,
                "minimumStaleTransitionsPerStewardCycle": 3,
                "requiredStaleTransition": "STALE -> ACTIONED/CLOSED",
                "targetStaleTransitionsThisCycle": 1,
            },
        )

        stale_records = plan["groups"]["likelySupersededOrStale"]
        self.assertEqual([item["conclusionId"] for item in stale_records], ["P0-SUPERSEDED"])
        self.assertEqual(stale_records[0]["recommendedDisposition"], "CLOSE_IF_SUPERSEDED")
        self.assertEqual(
            stale_records[0]["evidenceFlags"],
            ["status_stale", "statement_superseded", "category_stale"],
        )

        current_records = plan["groups"]["currentActionableBlockers"]
        self.assertEqual([item["conclusionId"] for item in current_records], ["P1-CURRENT-BLOCKER"])
        self.assertEqual(current_records[0]["recommendedDisposition"], "ROUTE_CURRENT_BLOCKER_FOR_EVIDENCE")
        self.assertEqual(
            current_records[0]["evidenceFlags"],
            [
                "linked_issue_present",
                "required_landing_evidence_present",
                "next_verification_present",
            ],
        )
        self.assertEqual(current_records[0]["linkedIssues"], ["#1540", "1542"])
        self.assertEqual(
            registry.summarize_conclusions(registry.normalize_conclusions(payload))["staleConclusionActionPlan"],
            plan,
        )

    def test_action_plan_handles_legacy_list_registry_and_orders_deterministically(self) -> None:
        payload = {
            "schemaVersion": 1,
            "registryType": "rl-conclusion-registry",
            "conclusions": [
                {
                    "conclusionId": "P1-STALE-OLDER",
                    "status": "STALE",
                    "severity": "P1",
                    "category": "runtime-evidence",
                    "lastSeenAt": "2026-05-01T00:00:00Z",
                },
                {
                    "conclusionId": "P0-OPEN",
                    "status": "OPEN",
                    "severity": "P0",
                    "category": "runtime-evidence",
                    "lastSeenAt": "2026-05-01T00:00:00Z",
                },
                {
                    "conclusionId": "P0-STALE-NEWER",
                    "status": "STALE",
                    "severity": "P0",
                    "category": "runtime-evidence",
                    "lastSeenAt": "2026-05-03T00:00:00Z",
                },
                {
                    "conclusionId": "P0-STALE-OLDER",
                    "status": "STALE",
                    "severity": "P0",
                    "category": "runtime-evidence",
                    "lastSeenAt": "2026-05-02T00:00:00Z",
                },
                {
                    "conclusionId": "P1-ACTIONED-IGNORED",
                    "status": "ACTIONED",
                    "severity": "P1",
                    "category": "runtime-evidence",
                },
            ],
        }

        plan = registry.build_stale_conclusion_action_plan(payload, preview_limit=3)

        self.assertEqual(plan["totalActionableCount"], 4)
        self.assertEqual(plan["staleDecisionBacklogCount"], 3)
        self.assertEqual(plan["countsByStatus"], {"OPEN": 1, "STALE": 3})
        self.assertEqual(plan["countsBySeverity"], {"P0": 3, "P1": 1})
        self.assertEqual(
            plan["highestPriorityConclusionIds"],
            ["P0-STALE-OLDER", "P0-STALE-NEWER", "P0-OPEN"],
        )
        self.assertEqual(plan["recommendedNextAction"]["targetStaleTransitionsThisCycle"], 3)
        self.assertEqual(
            [item["conclusionId"] for item in plan["groups"]["likelySupersededOrStale"]],
            ["P0-STALE-OLDER", "P0-STALE-NEWER", "P1-STALE-OLDER"],
        )
        self.assertEqual(
            [item["conclusionId"] for item in plan["groups"]["currentActionableBlockers"]],
            ["P0-OPEN"],
        )

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

        with self.assertRaisesRegex(registry.ConclusionRegistryError, "DUPLICATE-ID"):
            registry.normalize_conclusions(
                {
                    "schemaVersion": 1,
                    "registryType": "rl-conclusion-registry",
                    "conclusions": {
                        "DUPLICATE-ID": {"conclusionId": "DUPLICATE-ID", "status": "OPEN"},
                    },
                    "entries": [
                        {"conclusionId": "DUPLICATE-ID", "status": "CLOSED"},
                    ],
                }
            )

    def test_normalize_conclusions_accepts_mixed_registry_shapes(self) -> None:
        records = registry.normalize_conclusions(
            {
                "schemaVersion": 1,
                "type": "screeps-rl-conclusion-registry",
                "conclusions": {
                    "CANONICAL-DICT": {
                        "conclusionId": "CANONICAL-DICT",
                        "status": "ACTIONED",
                    },
                },
                "entries": [
                    {
                        "conclusionId": "LEGACY-ENTRY-LIST",
                        "status": "OPEN",
                    },
                    {
                        "conclusionId": "LEGACY-ENTRY-STALE",
                        "status": "STALE",
                    },
                ],
            }
        )

        self.assertEqual(
            sorted(records),
            ["CANONICAL-DICT", "LEGACY-ENTRY-LIST", "LEGACY-ENTRY-STALE"],
        )
        self.assertEqual(records["CANONICAL-DICT"]["status"], "ACTIONED")
        self.assertEqual(records["LEGACY-ENTRY-LIST"]["status"], "OPEN")
        self.assertEqual(records["LEGACY-ENTRY-STALE"]["status"], "STALE")

        single_record = registry.normalize_conclusions(
            {
                "conclusionId": "TOP-LEVEL-SINGLE",
                "status": "VALIDATING",
                "statement": "Single producer conclusion payload.",
            }
        )

        self.assertEqual(list(single_record), ["TOP-LEVEL-SINGLE"])
        self.assertEqual(single_record["TOP-LEVEL-SINGLE"]["status"], "VALIDATING")

    def test_linked_issue_gate_flags_unlinked_open_high_priority_conclusions(self) -> None:
        payload = {
            "schemaVersion": 1,
            "registryType": "rl-conclusion-registry",
            "conclusions": {
                "P1-UNLINKED": {
                    "conclusionId": "P1-UNLINKED",
                    "status": "OPEN",
                    "severity": "P1",
                    "category": "economy",
                    "lastSeenAt": "2026-06-07T00:00:00Z",
                    "statement": "Energy buffer collapse needs an atomic issue.",
                },
                "P2-EMPTY-LINKS": {
                    "conclusionId": "P2-EMPTY-LINKS",
                    "status": "OPEN",
                    "severity": "P2",
                    "linkedIssues": [],
                    "lastSeenAt": "2026-06-07T00:01:00Z",
                },
            },
            "entries": [
                {
                    "conclusionId": "P0-WHITESPACE-LINK",
                    "status": "OPEN",
                    "severity": "P0",
                    "linkedIssues": ["  "],
                    "lastSeenAt": "2026-06-07T00:02:00Z",
                }
            ],
        }

        gate = registry.build_open_conclusion_linked_issue_gate(payload)

        self.assertFalse(gate["ok"])
        self.assertEqual(gate["status"], "ACTION_REQUIRED")
        self.assertEqual(gate["requiredStatuses"], ["OPEN"])
        self.assertEqual(gate["requiredSeverities"], ["P0", "P1", "P2"])
        self.assertEqual(gate["blockedConclusionCount"], 3)
        self.assertEqual(gate["countsBySeverity"], {"P0": 1, "P1": 1, "P2": 1})
        self.assertEqual(
            gate["highestPriorityConclusionIds"],
            ["P0-WHITESPACE-LINK", "P1-UNLINKED", "P2-EMPTY-LINKS"],
        )
        self.assertEqual(
            [item["recommendedAction"] for item in gate["blockingConclusions"]],
            ["attach_exact_atomic_issue", "attach_exact_atomic_issue", "attach_exact_atomic_issue"],
        )
        self.assertEqual(gate["projectEvidence"]["status"], "BLOCKED_MISSING_LINKED_ISSUES")
        self.assertIn("#879", gate["routingPolicy"]["forbiddenBroadIssueSinks"])
        self.assertIn("#1589", gate["routingPolicy"]["forbiddenBroadIssueSinks"])

    def test_linked_issue_gate_rejects_forbidden_broad_issue_sinks(self) -> None:
        payload = {
            "schemaVersion": 1,
            "registryType": "rl-conclusion-registry",
            "conclusions": {
                "P1-BROAD-879": {
                    "conclusionId": "P1-BROAD-879",
                    "status": "OPEN",
                    "severity": "P1",
                    "category": "runtime",
                    "linkedIssues": ["#879"],
                },
                "P2-BROAD-893": {
                    "conclusionId": "P2-BROAD-893",
                    "status": "OPEN",
                    "severity": "P2",
                    "category": "economy",
                    "linkedIssues": ["#893"],
                },
                "P1-BROAD-1589": {
                    "conclusionId": "P1-BROAD-1589",
                    "status": "OPEN",
                    "severity": "P1",
                    "category": "ops",
                    "linkedIssues": ["#1589"],
                },
                "P0-BROAD-1543": {
                    "conclusionId": "P0-BROAD-1543",
                    "status": "OPEN",
                    "severity": "P0",
                    "category": "rl",
                    "linkedIssues": ["#1543"],
                },
            },
        }

        gate = registry.build_open_conclusion_linked_issue_gate(payload)

        self.assertFalse(gate["ok"])
        self.assertEqual(gate["status"], "ACTION_REQUIRED")
        self.assertEqual(gate["blockedConclusionCount"], 4)
        self.assertEqual(gate["countsBySeverity"], {"P0": 1, "P1": 2, "P2": 1})
        self.assertEqual(
            gate["routingPolicy"]["forbiddenBroadIssueSinks"],
            ["#879", "#893", "#1589", "#1543"],
        )
        self.assertEqual(
            gate["routingPolicy"]["requiredRouting"],
            "exact_atomic_issue_per_open_conclusion",
        )
        blocking_by_id = {
            item["conclusionId"]: item
            for item in gate["blockingConclusions"]
        }
        self.assertEqual(blocking_by_id["P1-BROAD-879"]["linkedIssues"], ["#879"])
        self.assertEqual(blocking_by_id["P1-BROAD-879"]["forbiddenLinkedIssueSinks"], ["#879"])
        self.assertEqual(blocking_by_id["P2-BROAD-893"]["linkedIssues"], ["#893"])
        self.assertEqual(blocking_by_id["P2-BROAD-893"]["forbiddenLinkedIssueSinks"], ["#893"])
        self.assertEqual(blocking_by_id["P1-BROAD-1589"]["linkedIssues"], ["#1589"])
        self.assertEqual(blocking_by_id["P1-BROAD-1589"]["forbiddenLinkedIssueSinks"], ["#1589"])
        self.assertEqual(blocking_by_id["P0-BROAD-1543"]["linkedIssues"], ["#1543"])
        self.assertEqual(blocking_by_id["P0-BROAD-1543"]["forbiddenLinkedIssueSinks"], ["#1543"])

    def test_linked_issue_gate_accepts_linked_and_non_open_or_lower_severity_shapes(self) -> None:
        payload = {
            "schemaVersion": 1,
            "type": "screeps-rl-conclusion-registry",
            "conclusions": [
                {
                    "conclusionId": "P1-LINKED",
                    "status": "OPEN",
                    "severity": "P1",
                    "linkedIssues": ["#1748"],
                },
                {
                    "conclusionId": "P2-MIXED-BROAD-AND-ATOMIC",
                    "status": "OPEN",
                    "severity": "P2",
                    "linkedIssues": ["#879", "#1750"],
                },
                {
                    "conclusionId": "P0-ACTIONED-UNLINKED",
                    "status": "ACTIONED",
                    "severity": "P0",
                },
            ],
            "entries": [
                {
                    "conclusionId": "P2-STALE-UNLINKED",
                    "status": "STALE",
                    "severity": "P2",
                },
                {
                    "conclusionId": "P3-OPEN-UNLINKED",
                    "status": "OPEN",
                    "severity": "P3",
                },
                {
                    "conclusionId": "UNRANKED-OPEN-UNLINKED",
                    "status": "OPEN",
                    "severity": "HIGH",
                },
            ],
        }

        gate = registry.build_open_conclusion_linked_issue_gate(payload)

        self.assertTrue(gate["ok"])
        self.assertEqual(gate["status"], "OK")
        self.assertEqual(gate["blockedConclusionCount"], 0)
        self.assertEqual(gate["countsBySeverity"], {"P0": 0, "P1": 0, "P2": 0})
        self.assertEqual(gate["highestPriorityConclusionIds"], [])
        self.assertEqual(gate["blockingConclusions"], [])
        self.assertEqual(gate["projectEvidence"]["status"], "OK")
        self.assertEqual(
            registry.summarize_conclusions(registry.normalize_conclusions(payload))["linkedIssueGate"],
            gate,
        )

    def test_merge_registry_file_accepts_metadata_only_existing_registry(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "conclusion-registry.json"
            path.write_text(
                registry.canonical_json(
                    {
                        "schemaVersion": 1,
                        "registryType": "rl-conclusion-registry",
                        "lastUpdatedAt": "2026-05-31T00:00:00Z",
                        "updatedBy": "bootstrap",
                        "summary": {"total": 0},
                    }
                ),
                encoding="utf-8",
            )

            merged = registry.merge_registry_file(
                path,
                [
                    {
                        "conclusionId": "E1-GATE-STATUS",
                        "status": "OPEN",
                        "statement": "Metadata-only registry can receive its first conclusion.",
                    },
                ],
                owner_cron="d6cff532edd4",
                updated_at="2026-06-01T00:00:00Z",
            )
            saved = read_json(path)

        self.assertEqual(saved, merged)
        self.assertEqual(saved["schemaVersion"], 1)
        self.assertEqual(saved["registryType"], "rl-conclusion-registry")
        self.assertEqual(list(saved["conclusions"]), ["E1-GATE-STATUS"])
        self.assertNotIn("summary", saved["conclusions"])
        self.assertEqual(saved["conclusions"]["E1-GATE-STATUS"]["ownerCron"], "d6cff532edd4")
        self.assertEqual(saved["summary"]["total"], 1)
        self.assertEqual(saved["summary"]["new"], 1)

    def test_loop_b_append_update_preserves_existing_entries_shape_records(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "conclusion-registry.json"
            path.write_text(
                registry.canonical_json(
                    {
                        "schemaVersion": 1,
                        "type": "screeps-rl-conclusion-registry",
                        "updatedAt": "2026-06-01T02:00:00Z",
                        "entries": [
                            {
                                "conclusionId": "LOOP-B-OLDER-OPEN",
                                "ownerCron": "01609968392a",
                                "status": "OPEN",
                                "severity": "P0",
                                "statement": "Older Loop B conclusion must remain visible.",
                            },
                            {
                                "conclusionId": "LOOP-B-ACTIONED",
                                "ownerCron": "01609968392a",
                                "status": "ACTIONED",
                                "severity": "P1",
                                "statement": "Loop B action remains in follow-up.",
                            },
                            {
                                "conclusionId": "STEWARD-STALE",
                                "ownerCron": "aed8362e4501",
                                "status": "STALE",
                                "severity": "P0",
                                "statement": "Steward stale backlog item must remain visible.",
                            },
                            {
                                "conclusionId": "E1-VALIDATING",
                                "ownerCron": "d6cff532edd4",
                                "status": "VALIDATING",
                                "severity": "P1",
                                "statement": "E1 validation must remain visible.",
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )

            merged = registry.merge_registry_file(
                path,
                {
                    "conclusionId": "LOOP-B-NEW-UNPROVEN",
                    "status": "OPEN",
                    "severity": "P0",
                    "statement": "New Loop B report remains unproven.",
                },
                owner_cron="01609968392a",
                updated_at="2026-06-01T02:59:07Z",
                updated_by="01609968392a",
                prune_omitted_owner_records=False,
            )
            saved = read_json(path)

        self.assertEqual(saved, merged)
        conclusions = saved["conclusions"]
        self.assertEqual(
            sorted(conclusions),
            [
                "E1-VALIDATING",
                "LOOP-B-ACTIONED",
                "LOOP-B-NEW-UNPROVEN",
                "LOOP-B-OLDER-OPEN",
                "STEWARD-STALE",
            ],
        )
        self.assertEqual(conclusions["LOOP-B-OLDER-OPEN"]["ownerCron"], "01609968392a")
        self.assertEqual(conclusions["LOOP-B-ACTIONED"]["status"], "ACTIONED")
        self.assertEqual(conclusions["STEWARD-STALE"]["ownerCron"], "aed8362e4501")
        self.assertEqual(conclusions["E1-VALIDATING"]["status"], "VALIDATING")
        self.assertEqual(conclusions["LOOP-B-NEW-UNPROVEN"]["ownerCron"], "01609968392a")
        self.assertEqual(conclusions["LOOP-B-NEW-UNPROVEN"]["lastSeenAt"], "2026-06-01T02:59:07Z")
        self.assertEqual(merged["summary"]["total"], 5)
        self.assertEqual(merged["summary"]["new"], 1)
        self.assertEqual(merged["summary"]["open"], 2)
        self.assertEqual(merged["summary"]["actioned"], 1)
        self.assertEqual(merged["summary"]["validating"], 1)
        self.assertEqual(merged["summary"]["staleOrEscalated"], 1)
        self.assertEqual(
            merged["summary"]["countsByStatus"],
            {
                "ACTIONED": 1,
                "CLOSED": 0,
                "ESCALATED": 0,
                "OPEN": 2,
                "STALE": 1,
                "VALIDATING": 1,
            },
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
