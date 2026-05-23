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
