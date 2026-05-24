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


if __name__ == "__main__":
    unittest.main()
