#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
PAGES_URL = "https://lanyusea.github.io/screeps/"
ACTIVE_CONTRACT_FILES = (
    Path("docs/ops/cron-and-route-registry.md"),
    Path("docs/ops/agent-operating-system.md"),
    Path("docs/ops/discord-project-spec.md"),
    Path("docs/ops/discord-server-configuration.md"),
    Path("docs/ops/discord-server-setup-guide.md"),
    Path("docs/ops/rl-live-dashboard-runbook.md"),
    Path("docs/ops/roadmap.md"),
    Path("docs/ops/screeps-world-profiles.md"),
    Path("scripts/screeps_rl_dashboard.py"),
)
RETIRED_ROADMAP_FANOUT_PATTERNS = (
    "92ca290f7996",
    "Screeps roadmap fanout reporter",
    "Roadmap fanout job",
    "roadmap fanout",
    "roadmap-channel fanout",
    "Roadmaps go to `#roadmap`",
    "roadmap phase or milestone changes → `#roadmap`",
    "`#roadmap` for phase, milestone, priority, or blocker changes",
    "Roadmap/priorities changed | `#roadmap`",
)


def load_kpi_checker_module() -> Any:
    module_path = REPO_ROOT / "scripts" / "check-roadmap-kpi-placeholders.py"
    spec = importlib.util.spec_from_file_location("check_roadmap_kpi_placeholders", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load check-roadmap-kpi-placeholders.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


kpi_checker = load_kpi_checker_module()


class RoadmapPagesContractTests(unittest.TestCase):
    def read(self, relative: Path) -> str:
        return (REPO_ROOT / relative).read_text(encoding="utf-8")

    def test_recurring_registry_has_no_retired_roadmap_discord_fanout(self) -> None:
        text = self.read(Path("docs/ops/cron-and-route-registry.md"))

        self.assertNotIn("92ca290f7996", text)
        self.assertNotIn("Screeps roadmap fanout reporter", text)
        self.assertNotIn("| Roadmap | `discord:#roadmap` | Roadmap snapshots and Pages/report updates. |", text)
        self.assertIn(PAGES_URL, text)

    def test_active_contracts_route_roadmap_reporting_to_pages(self) -> None:
        for relative in ACTIVE_CONTRACT_FILES:
            with self.subTest(path=str(relative)):
                text = self.read(relative)
                for pattern in RETIRED_ROADMAP_FANOUT_PATTERNS:
                    self.assertNotIn(pattern, text)
                self.assertIn(PAGES_URL, text)

    def test_roadmap_pages_refresh_uses_safe_checkout_credentials(self) -> None:
        text = self.read(Path(".github/workflows/roadmap-pages-refresh.yml"))

        self.assertNotIn("bearer ***", text)
        self.assertNotIn(".extraheader=AUTHORIZATION: bearer", text)
        self.assertIn("persist-credentials: true", text)
        self.assertIn("token: ${{ secrets.SCREEPS_ROADMAP_TOKEN }}", text)
        self.assertNotIn("secrets.SCREEPS_ROADMAP_TOKEN || github.token", text)

    def test_roadmap_pages_refresh_requires_automation_token_for_check_triggering(self) -> None:
        text = self.read(Path(".github/workflows/roadmap-pages-refresh.yml"))

        self.assertIn("GH_TOKEN: ${{ secrets.SCREEPS_ROADMAP_TOKEN }}", text)
        self.assertIn("GITHUB_TOKEN: ${{ secrets.SCREEPS_ROADMAP_TOKEN }}", text)
        self.assertIn("SCREEPS_ROADMAP_TOKEN_CONFIGURED: ${{ secrets.SCREEPS_ROADMAP_TOKEN != '' }}", text)
        self.assertIn("SCREEPS_ROADMAP_TOKEN is required so generated artifact PRs trigger normal repository checks.", text)

    def test_roadmap_pages_refresh_routes_changed_artifacts_through_pull_request(self) -> None:
        text = self.read(Path(".github/workflows/roadmap-pages-refresh.yml"))

        self.assertNotIn("git push origin HEAD:main", text)
        self.assertNotIn("HEAD:main", text)
        self.assertIn("pull-requests: write", text)
        self.assertIn("PAGES_REFRESH_BRANCH: automation/roadmap-pages-refresh", text)
        self.assertIn('git commit -m "chore(roadmap): refresh Pages artifacts"', text)
        self.assertNotIn("[skip ci]", text)
        self.assertIn('git push --force-with-lease origin HEAD:"${PAGES_REFRESH_BRANCH}"', text)
        self.assertIn("if: steps.commit.outputs.changed == 'true'", text)
        self.assertIn(
            'gh pr list --base main --head "${PAGES_REFRESH_BRANCH}" --state open --limit 1 --json number',
            text,
        )
        self.assertIn('gh pr edit "${existing_pr}" --title "${PR_TITLE}" --body "${PR_BODY}"', text)
        self.assertIn(
            'gh pr create --base main --head "${PAGES_REFRESH_BRANCH}" --title "${PR_TITLE}" --body "${PR_BODY}"',
            text,
        )

    def test_roadmap_pages_refresh_rebuilds_legacy_pages_when_no_artifacts_changed(self) -> None:
        text = self.read(Path(".github/workflows/roadmap-pages-refresh.yml"))

        self.assertIn('echo "changed=false" >> "$GITHUB_OUTPUT"', text)
        self.assertIn("if: steps.commit.outputs.changed == 'false'", text)
        self.assertIn('gh api -X POST "repos/${GITHUB_REPOSITORY}/pages/builds" --silent', text)

    def test_roadmap_pages_refresh_collects_live_runtime_summary_before_generation(self) -> None:
        text = self.read(Path(".github/workflows/roadmap-pages-refresh.yml"))

        self.assertIn("SCREEPS_AUTH_TOKEN: ${{ secrets.SCREEPS_AUTH_TOKEN }}", text)
        self.assertIn("SCREEPS_MONITOR_CACHE_DIR: runtime-artifacts/screeps-monitor/terrain-cache", text)
        self.assertIn("SCREEPS_MONITOR_STATE_FILE: runtime-artifacts/screeps-monitor/state.json", text)
        self.assertNotIn("SCREEPS_MONITOR_CACHE_DIR: /root/", text)
        self.assertIn("mkdir -p runtime-artifacts/screeps-monitor runtime-artifacts/runtime-summary-console runtime-artifacts/cron-output", text)
        self.assertIn("python3 scripts/screeps-runtime-monitor.py summary", text)
        self.assertIn("--out-dir runtime-artifacts/screeps-monitor", text)
        self.assertIn("--runtime-summary-out-dir runtime-artifacts/runtime-summary-console", text)
        self.assertIn("> runtime-artifacts/screeps-monitor/summary.json", text)
        self.assertIn("SCREEPS_AUTH_TOKEN is not configured; skipping live Screeps runtime summary capture.", text)
        self.assertIn("--cron-output-root runtime-artifacts/cron-output", text)
        self.assertNotIn("--room", text)

    def test_deploy_process_metric_rejects_bool_values(self) -> None:
        cards = [
            {"label": label, "value": True if label == "Deploys" else 1}
            for label in kpi_checker.EXPECTED_PROCESS_LABELS
        ]
        data = {
            "report": {"processCards": cards},
            "github": {
                "issues": [{"evidence": "official deploy run 123456 succeeded"}],
                "projectItems": [],
            },
        }
        failures: list[str] = []

        kpi_checker.validate_process_metrics(data, failures)

        self.assertIn("Deploys must either reflect observed official deploy evidence", "\n".join(failures))

    def test_process_metric_rejects_values_without_current_local_cache_evidence(self) -> None:
        cards = [
            {
                "label": label,
                "value": "1.2B" if label == "Agent tokens" else "unavailable",
                "detail": (
                    "1,182,878,241 total; local cache only; "
                    "current refresh found no local cache evidence"
                    if label == "Agent tokens"
                    else "unavailable"
                ),
            }
            for label in kpi_checker.EXPECTED_PROCESS_LABELS
        ]
        data = {
            "report": {"processCards": cards},
            "github": {"issues": [], "projectItems": []},
        }
        failures: list[str] = []

        kpi_checker.validate_process_metrics(data, failures)

        self.assertIn("Agent tokens reports no current local cache evidence", "\n".join(failures))

    def test_process_metric_rejects_counted_provenance_when_local_cache_withheld(self) -> None:
        cards = [
            {
                "label": label,
                "value": "unavailable",
                "detail": (
                    "prior local cache snapshot withheld from value; "
                    "current refresh found no local cache evidence"
                    if label == "Agent tokens"
                    else "unavailable"
                ),
                "provenance": (
                    {
                        "window": {"start": "2026-05-21T05:32:54Z", "end": "2026-05-28T05:32:54Z"},
                        "capturedRange": {"start": "2026-05-21T05:17:53Z", "end": "2026-05-28T05:25:46Z"},
                        "completeness": {"countedArtifacts": 482},
                        "countedIds": ["2026/05/28/rollout-old.jsonl:2026-05-28T05:25:46Z"],
                    }
                    if label == "Agent tokens"
                    else {}
                ),
            }
            for label in kpi_checker.EXPECTED_PROCESS_LABELS
        ]
        data = {
            "generatedAt": "2026-05-28T10:34:20Z",
            "report": {"processCards": cards},
            "github": {"issues": [], "projectItems": []},
        }
        failures: list[str] = []

        kpi_checker.validate_process_metrics(data, failures)

        joined = "\n".join(failures)
        self.assertIn("Agent tokens with withheld local cache evidence must not expose counted provenance", joined)
        self.assertIn("Agent tokens with withheld local cache evidence must not expose counted provenance ids", joined)
        self.assertIn("Agent tokens with withheld local cache evidence must use the current generatedAt provenance window", joined)

    def test_project_handoff_evidence_rejects_blank_active_in_review_and_recent_done_items(self) -> None:
        generator = kpi_checker.load_generator(REPO_ROOT)
        data = {
            "github": {
                "projectItemsSource": "live",
                "projectItems": [
                    {
                        "number": 1479,
                        "type": "Issue",
                        "status": "In progress",
                        "priority": "P0",
                        "title": "P0 monitor recurrence",
                        "evidence": "",
                    },
                    {
                        "number": 1484,
                        "type": "PullRequest",
                        "status": "In review",
                        "priority": "P0",
                        "title": "review-stage handoff",
                        "evidence": "",
                    },
                    {
                        "number": 1483,
                        "type": "PullRequest",
                        "status": "Done",
                        "priority": "P0",
                        "title": "fix(rl): add lexicographic gradient estimator",
                        "evidence": "",
                    },
                    {
                        "number": 1200,
                        "type": "PullRequest",
                        "status": "Done",
                        "priority": "P0",
                        "title": "legacy Done item from before the evidence gate",
                        "evidence": "",
                    },
                ],
                "roadmapCards": [
                    {
                        "number": 1479,
                        "type": "Issue",
                        "status": "In progress",
                        "priority": "P0",
                        "title": "P0 monitor recurrence",
                        "evidence": "",
                    },
                    {
                        "number": 1484,
                        "type": "PullRequest",
                        "status": "In review",
                        "priority": "P0",
                        "title": "review-stage handoff",
                        "evidence": "",
                    },
                ],
                "kanban": {
                    "cards": [
                        {
                            "number": 1485,
                            "type": "PullRequest",
                            "status": "In review",
                            "priority": "P0",
                            "title": "review-stage flat kanban handoff",
                            "evidence": "",
                        }
                    ],
                    "columns": [
                        {
                            "domain": "Automation",
                            "statuses": [
                                {
                                    "status": "In review",
                                    "cards": [
                                        {
                                            "number": 1486,
                                            "type": "PullRequest",
                                            "status": "In review",
                                            "priority": "P0",
                                            "title": "review-stage nested kanban handoff",
                                            "evidence": "",
                                        }
                                    ],
                                }
                            ],
                        }
                    ],
                },
            }
        }

        failures = generator.validate_project_handoff_evidence(data)
        joined = "\n".join(failures)

        self.assertIn("github.projectItems[0] #1479 In progress", joined)
        self.assertIn("github.projectItems[1] #1484 In review", joined)
        self.assertIn("github.projectItems[2] #1483 Done", joined)
        self.assertIn("github.roadmapCards[0] #1479 In progress", joined)
        self.assertIn("github.roadmapCards[1] #1484 In review", joined)
        self.assertIn("github.kanban.cards[0] #1485 In review", joined)
        self.assertIn("github.kanban.columns[0].statuses[0].cards[0] #1486 In review", joined)
        self.assertNotIn("#1200", joined)

    def test_project_handoff_evidence_warns_when_project_evidence_field_is_not_hydrated(self) -> None:
        generator = kpi_checker.load_generator(REPO_ROOT)
        data = {
            "github": {
                "projectItemsSource": "live",
                "projectTextFieldHydration": {
                    "source": "gh project item-list",
                    "itemsInspected": 2,
                    "fields": {
                        "evidence": {"hydrated": False, "observedKeys": []},
                        "nextAction": {"hydrated": True, "observedKeys": ["Next action"]},
                        "blockedBy": {"hydrated": True, "observedKeys": ["Blocked by"]},
                    },
                },
                "projectItems": [
                    {
                        "number": 1656,
                        "type": "Issue",
                        "status": "In review",
                        "priority": "P0",
                        "title": "review-stage handoff with omitted text fields",
                        "evidence": "",
                    }
                ],
            }
        }

        failures = generator.validate_project_handoff_evidence(data)
        summary = generator.project_handoff_evidence_validation_summary(data["github"])

        self.assertEqual(failures, [])
        self.assertEqual(summary["mode"], "skipped")
        self.assertEqual(summary["severity"], "warning")
        self.assertEqual(summary["reason"], "project-evidence-field-unhydrated")


if __name__ == "__main__":
    unittest.main()
