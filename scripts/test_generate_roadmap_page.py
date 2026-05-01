#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
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


class GenerateRoadmapPageTest(unittest.TestCase):
    def test_screeps_room_target_falls_back_to_current_official_room(self) -> None:
        target = roadmap.build_screeps_room_target({})

        self.assertEqual(target["status"], "official target")
        self.assertEqual(target["label"], "shardX/E26S49")
        self.assertEqual(target["shard"], "shardX")
        self.assertEqual(target["room"], "E26S49")
        self.assertEqual(target["url"], "https://screeps.com/a/#!/room/shardX/E26S49")

    def test_counts_only_successful_official_deploy_evidence_json(self) -> None:
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

            summary = roadmap.summarize_official_deploy_evidence(repo_root)

        self.assertEqual(summary.count, 2)
        self.assertIsNotNone(summary.latest)
        self.assertEqual(summary.latest.commit, "b" * 40)
        self.assertEqual(summary.latest.run_id, "8675309")

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
                patch.object(roadmap, "count_private_smoke_process_reports", return_value=1),
            ):
                cards = roadmap.build_report_process_cards(repo_root, {"fullName": "lanyusea/screeps"}, {}, {})

        release_card = next(card for card in cards if card["label"] == "Official deploys")
        self.assertEqual(release_card["value"], 1)
        self.assertEqual(release_card["source"], "official deploy evidence JSON")
        self.assertIn("latest commit cccccccccccc", release_card["detail"])
        self.assertIn("run 123456", release_card["detail"])

    def test_report_groups_visible_work_by_project_domain(self) -> None:
        repo = {
            "fullName": "lanyusea/screeps",
            "url": "https://github.com/lanyusea/screeps",
            "projectUrl": "https://github.com/users/lanyusea/projects/3",
        }
        github_snapshot = {
            "sourceMode": "live",
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

        self.assertEqual([card["title"] for card in roadmap_cards], list(roadmap.PROJECT_DOMAIN_ORDER))
        self.assertEqual([column["title"] for column in domain_board], list(roadmap.PROJECT_DOMAIN_ORDER))

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
                    for domain in roadmap.PROJECT_DOMAIN_ORDER
                ],
                "domainKanban": [{"title": domain, "items": []} for domain in roadmap.PROJECT_DOMAIN_ORDER],
                "processCards": [],
            },
        }

        html = roadmap.render_html(data)

        self.assertIn("02 Project Domains", html)
        self.assertIn("03 Project Domain Board", html)
        self.assertNotIn("02 Development Roadmap - Six Tracks", html)
        self.assertNotIn("03 Gameplay Strategy Kanban", html)
        self.assertNotIn("04 Foundation Delivery Kanban", html)
        self.assertNotIn("Resource Economy", html)
        self.assertNotIn("Reliability / P0", html)
        self.assertNotIn("Foundation Gates", html)


if __name__ == "__main__":
    unittest.main()
