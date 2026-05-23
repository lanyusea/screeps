#!/usr/bin/env python3
from __future__ import annotations

import unittest
from pathlib import Path


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


if __name__ == "__main__":
    unittest.main()
