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

        official_card = next(card for card in cards if card["label"] == "Official deploys")
        self.assertEqual(official_card["value"], 1)
        self.assertEqual(official_card["source"], "official deploy evidence JSON")
        self.assertIn("latest commit cccccccccccc", official_card["detail"])
        self.assertIn("run 123456", official_card["detail"])


if __name__ == "__main__":
    unittest.main()
