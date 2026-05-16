#!/usr/bin/env python3
from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import check_scheduler_report_tripwire as tripwire


class SchedulerReportTripwireTest(unittest.TestCase):
    def test_fails_p1_action_item_without_same_item_issue_reference(self) -> None:
        report = """## P1 next actions
- Repair the PM scheduler prose-only completion gap before the next run.
"""

        findings = tripwire.find_untracked_action_items("report.md", report)

        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].line, 2)
        self.assertEqual(findings[0].priority, "P1")
        self.assertIn("prose-only", findings[0].text)

    def test_accepts_issue_link_on_same_action_item(self) -> None:
        report = """## P1 next actions
- #1108 Repair the PM scheduler prose-only completion gap before the next run.
- https://github.com/lanyusea/screeps/issues/1028 Refresh the no-prose-only gate evidence.
"""

        findings = tripwire.find_untracked_action_items("report.md", report)

        self.assertEqual(findings, [])

    def test_fails_inline_p0_gap_even_without_priority_heading(self) -> None:
        report = "P0 action item: create GitHub issue for stale Project completion evidence.\n"

        findings = tripwire.find_untracked_action_items("-", report)

        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].priority, "P0")
        self.assertIn("action item", findings[0].phrase.lower())

    def test_ignores_lower_priority_and_negative_status_summaries(self) -> None:
        report = """No P0/P1 action items remain untracked.

## P2 next actions
- Repair the dashboard placeholder after the current release gate.
"""

        findings = tripwire.find_untracked_action_items("report.md", report)

        self.assertEqual(findings, [])

    def test_priority_context_does_not_leak_to_sibling_heading(self) -> None:
        report = """## P1 next actions
- #1108 Repair the PM scheduler prose-only completion gap.

## Completed
- Fixed report wording in the posted summary.
"""

        findings = tripwire.find_untracked_action_items("report.md", report)

        self.assertEqual(findings, [])

    def test_cli_reports_failure_for_stdin(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = tripwire.main(
            ["-"],
            stdin=io.StringIO("P1 follow-up: track the missing report gate.\n"),
            stdout=stdout,
            stderr=stderr,
        )

        self.assertEqual(exit_code, 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("FAIL: scheduler report contains untracked P0/P1", stderr.getvalue())
        self.assertIn("-:1", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
