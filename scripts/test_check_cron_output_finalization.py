#!/usr/bin/env python3
from __future__ import annotations

import io
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import check_cron_output_finalization as finalization


BROKEN_PIPE_ARTIFACT = """# Cron Job: Screeps Gameplay Evolution Review (FAILED)

**Job ID:** c7b3dda8f1ac

## Prompt

long prompt omitted

## Error

```
RuntimeError: [Errno 32] Broken pipe
```
"""


VALID_GAMEPLAY_ARTIFACT = """# Cron Job: Screeps Gameplay Evolution Review

**Job ID:** c7b3dda8f1ac

## Prompt

prompt omitted

## Response

# Gameplay Evolution Review

## Vision KPI summary
- Territory: 3 rooms.

## Practical gameplay closed-loop gate
- OK / STRATEGIC_STALL / CLOSED_LOOP_FAILED: OK.

## RL Flywheel Product Review
- Product assessment: held behind construction acceptance.

## Recommended roadmap changes
| Rank | Action | GitHub target | Expected KPI movement |
| --- | --- | --- | --- |
| 1 | Keep construction acceptance active | #1831, #1846 | build progress resumes |
"""


class CronOutputFinalizationTest(unittest.TestCase):
    def test_classifies_broken_pipe_as_outer_cron_finalization(self) -> None:
        diagnostic = finalization.diagnose_text(
            BROKEN_PIPE_ARTIFACT,
            path="failed.md",
            mode="gameplay-review",
            route_issue="#1860",
            expected_job_id="c7b3dda8f1ac",
        )

        self.assertFalse(diagnostic.ok)
        self.assertEqual(diagnostic.classification, "outer_cron_finalization")
        self.assertEqual(diagnostic.route_issue, "#1860")
        self.assertFalse(diagnostic.response_present)
        self.assertTrue(diagnostic.broken_pipe)

    def test_accepts_valid_gameplay_response_and_extracts_targets(self) -> None:
        diagnostic = finalization.diagnose_text(
            VALID_GAMEPLAY_ARTIFACT,
            path="ok.md",
            mode="gameplay-review",
            route_issue="#1860",
            expected_job_id="c7b3dda8f1ac",
        )

        self.assertTrue(diagnostic.ok)
        self.assertEqual(diagnostic.classification, "response_ok")
        self.assertEqual(diagnostic.github_targets, ["#1831", "#1846"])

    def test_accepts_exact_silent_response(self) -> None:
        artifact = """# Cron Job: Screeps Gameplay Evolution Review

**Job ID:** c7b3dda8f1ac

## Response

[SILENT]
"""

        diagnostic = finalization.diagnose_text(
            artifact,
            path="silent.md",
            mode="gameplay-review",
            route_issue="#1860",
            expected_job_id="c7b3dda8f1ac",
        )

        self.assertTrue(diagnostic.ok)
        self.assertTrue(diagnostic.silent)
        self.assertEqual(diagnostic.classification, "silent")

    def test_rejects_gameplay_response_without_target_list(self) -> None:
        artifact = VALID_GAMEPLAY_ARTIFACT.replace(
            "| 1 | Keep construction acceptance active | #1831, #1846 | build progress resumes |\n",
            "",
        )

        diagnostic = finalization.diagnose_text(
            artifact,
            path="missing-targets.md",
            mode="gameplay-review",
            route_issue="#1860",
            expected_job_id="c7b3dda8f1ac",
        )

        self.assertFalse(diagnostic.ok)
        self.assertEqual(diagnostic.classification, "invalid_gameplay_review_output")
        self.assertIn("github_target_refs", diagnostic.missing_sections)

    def test_cli_fails_closed_on_oversized_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact = Path(tmpdir) / "oversized.md"
            artifact.write_text("too large", encoding="utf-8")
            stdout = io.StringIO()
            stderr = io.StringIO()

            exit_code = finalization.main(
                [str(artifact), "--max-bytes", "3"],
                stdout=stdout,
                stderr=stderr,
            )

        self.assertEqual(exit_code, 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("artifact_unreadable_or_oversized", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
