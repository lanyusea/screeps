#!/usr/bin/env python3
from __future__ import annotations

import io
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import gameplay_evolution_issue_creator as creator


SAMPLE_PATH = Path(__file__).parent / "fixtures" / "gameplay_evolution_findings.sample.json"


class FakeRunner:
    def __init__(self) -> None:
        self.commands: list[list[str]] = []
        self.issue_bodies: list[str] = []

    def run(self, args: list[str]) -> str:
        self.commands.append(list(args))
        if args[:3] == ["gh", "project", "view"]:
            return json.dumps({"id": "project-id"})
        if args[:3] == ["gh", "project", "field-list"]:
            return json.dumps(
                {
                    "fields": [
                        {
                            "id": "status-field",
                            "name": "Status",
                            "options": [{"id": "backlog-option", "name": "Backlog"}],
                        },
                        {
                            "id": "domain-field",
                            "name": "Domain",
                            "options": [{"id": "gameplay-option", "name": "Gameplay Evolution"}],
                        },
                    ]
                }
            )
        if args[:3] == ["gh", "issue", "create"]:
            body_file = Path(args[args.index("--body-file") + 1])
            self.issue_bodies.append(body_file.read_text(encoding="utf-8"))
            return "https://github.com/lanyusea/screeps/issues/900"
        if args[:3] == ["gh", "project", "item-add"]:
            return json.dumps({"id": "item-id"})
        if args[:3] == ["gh", "project", "item-edit"]:
            return "{}"
        raise AssertionError(f"unexpected command: {args}")


class GameplayEvolutionIssueCreatorTest(unittest.TestCase):
    def test_sample_finding_renders_required_issue_mapping(self) -> None:
        plans = creator.build_issue_plans(SAMPLE_PATH)

        self.assertEqual(len(plans), 1)
        plan = plans[0]
        self.assertTrue(plan.title.startswith("P1: [Gameplay Evolution]"))
        self.assertIn("Parent: #59 Gameplay Evolution vision-driven loop", plan.body)
        self.assertIn("Source review artifact: [docs/process/2026-05-09-gameplay-evolution-review.md]", plan.body)
        self.assertIn("- Evidence window: 2026-05-09T00:00:00Z..2026-05-09T06:00:00Z", plan.body)
        self.assertIn("- No-secret considerations: Only sanitized review metadata", plan.body)
        self.assertIn("## Acceptance criteria", plan.body)

    def test_dry_run_uses_sample_without_gh_calls(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = creator.main([str(SAMPLE_PATH), "--dry-run"], stdout=stdout, stderr=stderr)

        self.assertEqual(exit_code, 0, stderr.getvalue())
        rendered = stdout.getvalue()
        self.assertIn("DRY RUN: would create 1 issue(s) in lanyusea/screeps", rendered)
        self.assertIn("Milestone: Phase C: Runtime telemetry / monitor gate", rendered)
        self.assertIn("Labels: priority:p1, roadmap, kind:code, roadmap:gameplay-evolution", rendered)
        self.assertIn("Domain=Gameplay Evolution", rendered)
        self.assertIn("Status=Backlog", rendered)
        self.assertIn("gh issue create", rendered)

    def test_create_flow_invokes_issue_and_project_commands(self) -> None:
        runner = FakeRunner()
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = creator.main([str(SAMPLE_PATH)], stdout=stdout, stderr=stderr, runner=runner)  # type: ignore[arg-type]

        self.assertEqual(exit_code, 0, stderr.getvalue())
        self.assertEqual(stdout.getvalue().strip(), "https://github.com/lanyusea/screeps/issues/900")
        self.assertEqual(runner.commands[0][:4], ["gh", "project", "view", "3"])
        self.assertEqual(runner.commands[1][:4], ["gh", "project", "field-list", "3"])
        issue_command = runner.commands[2]
        self.assertEqual(issue_command[:3], ["gh", "issue", "create"])
        self.assertIn("--repo", issue_command)
        self.assertIn("lanyusea/screeps", issue_command)
        self.assertIn("--milestone", issue_command)
        self.assertIn("Phase C: Runtime telemetry / monitor gate", issue_command)
        for label in creator.DEFAULT_LABELS:
            self.assertIn(label, issue_command)
        self.assertEqual(runner.commands[3][:3], ["gh", "project", "item-add"])
        edit_commands = [command for command in runner.commands if command[:3] == ["gh", "project", "item-edit"]]
        self.assertEqual(len(edit_commands), 2)
        self.assertTrue(any("backlog-option" in command for command in edit_commands))
        self.assertTrue(any("gameplay-option" in command for command in edit_commands))
        self.assertIn("Parent: #59", runner.issue_bodies[0])
        self.assertIn("roadmap", " ".join(issue_command))

    def test_missing_intake_field_fails_before_creation(self) -> None:
        with self.assertRaises(creator.InputError) as context:
            creator.raw_findings({"findings": ["not an object"]})

        self.assertIn("finding 1: expected object", str(context.exception))


if __name__ == "__main__":
    unittest.main()
