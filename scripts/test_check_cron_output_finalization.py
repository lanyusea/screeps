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


VALID_GAMEPLAY_RESPONSE = """\
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


VALID_GAMEPLAY_ARTIFACT = f"""# Cron Job: Screeps Gameplay Evolution Review

**Job ID:** c7b3dda8f1ac

## Prompt

prompt omitted

## Response

{VALID_GAMEPLAY_RESPONSE}"""


PROMPT_GAMEPLAY_RESPONSE_TEMPLATE = """\
# Gameplay Evolution Review

## Scope
- Time window reviewed:
- Repo commit:

## Vision KPI summary
- Territory:
- Resource/economy:
- Combat/enemy damage:
- Reliability guardrails:

## Practical gameplay closed-loop gate
- OK / STRATEGIC_STALL / CLOSED_LOOP_FAILED:

## RL Flywheel Product Review
- Steward run reviewed: <timestamp from latest Steward output>
- Product assessment: <is RL producing actionable strategy improvements?>

## Recommended roadmap changes
| Rank | Action | Served vision layer | GitHub target | Expected KPI movement |
| --- | --- | --- | --- | --- |
| 1 | Example finalization repair | Agent OS | #1860 | route missing final responses |
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

    def test_accepts_valid_gameplay_response_with_broken_pipe_prose(self) -> None:
        response = VALID_GAMEPLAY_RESPONSE.replace(
            "- Territory: 3 rooms.",
            "- Territory: 3 rooms.\n- Reliability evidence: no Broken pipe in the latest cron transport.",
        )
        artifact = f"""# Cron Job: Screeps Gameplay Evolution Review

**Job ID:** c7b3dda8f1ac

## Prompt

The reliability checklist asks whether there was a Broken pipe in cron transport.

## Response

{response}"""

        diagnostic = finalization.diagnose_text(
            artifact,
            path="broken-pipe-prose.md",
            mode="gameplay-review",
            route_issue="#1860",
            expected_job_id="c7b3dda8f1ac",
        )

        self.assertTrue(diagnostic.ok)
        self.assertEqual(diagnostic.classification, "response_ok")
        self.assertFalse(diagnostic.broken_pipe)

    def test_prompt_broken_pipe_error_example_does_not_mask_final_response(self) -> None:
        artifact = f"""# Cron Job: Screeps Gameplay Evolution Review

**Job ID:** c7b3dda8f1ac

## Prompt

Example failure shape:

## Error

```
RuntimeError: [Errno 32] Broken pipe
```

## Response

{VALID_GAMEPLAY_RESPONSE}"""

        diagnostic = finalization.diagnose_text(
            artifact,
            path="prompt-broken-pipe-example.md",
            mode="gameplay-review",
            route_issue="#1860",
            expected_job_id="c7b3dda8f1ac",
        )

        self.assertTrue(diagnostic.ok)
        self.assertEqual(diagnostic.classification, "response_ok")
        self.assertFalse(diagnostic.broken_pipe)

    def test_rejects_missing_job_id_when_expected(self) -> None:
        artifact = f"""# Cron Job: Screeps Gameplay Evolution Review

## Response

{VALID_GAMEPLAY_RESPONSE}"""

        diagnostic = finalization.diagnose_text(
            artifact,
            path="missing-job-id.md",
            mode="gameplay-review",
            route_issue="#1860",
            expected_job_id="c7b3dda8f1ac",
        )

        self.assertFalse(diagnostic.ok)
        self.assertEqual(diagnostic.classification, "missing_job_id")
        self.assertIsNone(diagnostic.job_id)
        self.assertEqual(diagnostic.expected_job_id, "c7b3dda8f1ac")
        self.assertTrue(diagnostic.response_present)
        self.assertFalse(diagnostic.error_present)
        self.assertFalse(diagnostic.broken_pipe)
        self.assertEqual(diagnostic.missing_sections, [])
        self.assertEqual(diagnostic.github_targets, [])

    def test_prompt_response_header_does_not_mask_final_response(self) -> None:
        artifact = f"""# Cron Job: Screeps Gameplay Evolution Review

**Job ID:** c7b3dda8f1ac

## Prompt

The final output should use this shape:

## Response

<gameplay review body>

## Response

{VALID_GAMEPLAY_RESPONSE}"""

        diagnostic = finalization.diagnose_text(
            artifact,
            path="prompt-response-boilerplate.md",
            mode="gameplay-review",
            route_issue="#1860",
            expected_job_id="c7b3dda8f1ac",
        )

        expected_response_bytes = len(VALID_GAMEPLAY_RESPONSE.strip().encode("utf-8"))
        self.assertTrue(diagnostic.ok)
        self.assertEqual(diagnostic.classification, "response_ok")
        self.assertEqual(diagnostic.response_bytes, expected_response_bytes)

    def test_rejects_prompt_only_gameplay_response_template(self) -> None:
        artifact = f"""# Cron Job: Screeps Gameplay Evolution Review

**Job ID:** c7b3dda8f1ac

## Prompt

The final output should use this response template:

## Response

{PROMPT_GAMEPLAY_RESPONSE_TEMPLATE}"""

        diagnostic = finalization.diagnose_text(
            artifact,
            path="prompt-only-response-template.md",
            mode="gameplay-review",
            route_issue="#1860",
            expected_job_id="c7b3dda8f1ac",
        )

        self.assertFalse(diagnostic.ok)
        self.assertEqual(diagnostic.classification, "missing_response")
        self.assertFalse(diagnostic.response_present)
        self.assertEqual(diagnostic.response_bytes, 0)

    def test_accepts_real_response_after_prompt_gameplay_response_template(self) -> None:
        artifact = f"""# Cron Job: Screeps Gameplay Evolution Review

**Job ID:** c7b3dda8f1ac

## Prompt

The final output should use this response template:

## Response

{PROMPT_GAMEPLAY_RESPONSE_TEMPLATE}

## Response

{VALID_GAMEPLAY_RESPONSE}"""

        diagnostic = finalization.diagnose_text(
            artifact,
            path="final-response-after-prompt-template.md",
            mode="gameplay-review",
            route_issue="#1860",
            expected_job_id="c7b3dda8f1ac",
        )

        expected_response_bytes = len(VALID_GAMEPLAY_RESPONSE.strip().encode("utf-8"))
        self.assertTrue(diagnostic.ok)
        self.assertEqual(diagnostic.classification, "response_ok")
        self.assertEqual(diagnostic.response_bytes, expected_response_bytes)
        self.assertEqual(diagnostic.github_targets, ["#1831", "#1846"])

    def test_prompt_error_header_does_not_mask_final_broken_pipe_error(self) -> None:
        artifact = """# Cron Job: Screeps Gameplay Evolution Review (FAILED)

**Job ID:** c7b3dda8f1ac

## Prompt

The final output may include:

## Error

<transport error text>

## Error

```
RuntimeError: [Errno 32] Broken pipe
```
"""

        diagnostic = finalization.diagnose_text(
            artifact,
            path="prompt-error-boilerplate.md",
            mode="gameplay-review",
            route_issue="#1860",
            expected_job_id="c7b3dda8f1ac",
        )

        self.assertFalse(diagnostic.ok)
        self.assertEqual(diagnostic.classification, "outer_cron_finalization")
        self.assertTrue(diagnostic.error_present)
        self.assertTrue(diagnostic.broken_pipe)

    def test_response_heading_examples_do_not_mask_final_broken_pipe_error(self) -> None:
        artifact = """# Cron Job: Screeps Gameplay Evolution Review (FAILED)

**Job ID:** c7b3dda8f1ac

## Prompt

The prompt includes unrelated output examples.

## Response

<example response text>

## Error

<example error text>

## Response

Partial response before transport failure:

## Response

<nested response example>

## Error

<nested error example>

## Error

```
RuntimeError: [Errno 32] Broken pipe
```
"""

        diagnostic = finalization.diagnose_text(
            artifact,
            path="response-heading-examples-final-error.md",
            mode="gameplay-review",
            route_issue="#1860",
            expected_job_id="c7b3dda8f1ac",
        )

        self.assertFalse(diagnostic.ok)
        self.assertEqual(diagnostic.classification, "outer_cron_finalization")
        self.assertTrue(diagnostic.error_present)
        self.assertTrue(diagnostic.broken_pipe)

    def test_broken_pipe_after_response_fails_closed(self) -> None:
        artifact = f"""# Cron Job: Screeps Gameplay Evolution Review

**Job ID:** c7b3dda8f1ac

## Response

{VALID_GAMEPLAY_RESPONSE}
RuntimeError: [Errno 32] Broken pipe
"""

        diagnostic = finalization.diagnose_text(
            artifact,
            path="response-with-broken-pipe.md",
            mode="gameplay-review",
            route_issue="#1860",
            expected_job_id="c7b3dda8f1ac",
        )

        self.assertFalse(diagnostic.ok)
        self.assertEqual(diagnostic.classification, "outer_cron_finalization")
        self.assertTrue(diagnostic.response_present)
        self.assertTrue(diagnostic.broken_pipe)

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

    def test_rejects_gameplay_refs_outside_roadmap_table(self) -> None:
        response = VALID_GAMEPLAY_RESPONSE.replace(
            "- Product assessment: held behind construction acceptance.",
            "- Product assessment: #1831 is still relevant.",
        ).replace(
            "| 1 | Keep construction acceptance active | #1831, #1846 | build progress resumes |\n",
            "",
        )
        artifact = f"""# Cron Job: Screeps Gameplay Evolution Review

**Job ID:** c7b3dda8f1ac

## Response

{response}"""

        diagnostic = finalization.diagnose_text(
            artifact,
            path="target-outside-roadmap.md",
            mode="gameplay-review",
            route_issue="#1860",
            expected_job_id="c7b3dda8f1ac",
        )

        self.assertFalse(diagnostic.ok)
        self.assertEqual(diagnostic.classification, "invalid_gameplay_review_output")
        self.assertIn("github_target_refs", diagnostic.missing_sections)
        self.assertEqual(diagnostic.github_targets, [])

    def test_rejects_gameplay_refs_in_roadmap_prose_without_target_row(self) -> None:
        response = VALID_GAMEPLAY_RESPONSE.replace(
            "| 1 | Keep construction acceptance active | #1831, #1846 | build progress resumes |\n",
            "\nRelated issue: #1831\n",
        )
        artifact = f"""# Cron Job: Screeps Gameplay Evolution Review

**Job ID:** c7b3dda8f1ac

## Response

{response}"""

        diagnostic = finalization.diagnose_text(
            artifact,
            path="target-in-roadmap-prose.md",
            mode="gameplay-review",
            route_issue="#1860",
            expected_job_id="c7b3dda8f1ac",
        )

        self.assertFalse(diagnostic.ok)
        self.assertEqual(diagnostic.classification, "invalid_gameplay_review_output")
        self.assertIn("github_target_refs", diagnostic.missing_sections)
        self.assertEqual(diagnostic.github_targets, [])

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

    def test_cli_fails_closed_on_invalid_utf8_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact = Path(tmpdir) / "invalid.md"
            artifact.write_bytes(b"# Cron Job\n\n## Response\n\nvalid prefix \xff")
            stdout = io.StringIO()
            stderr = io.StringIO()

            exit_code = finalization.main(
                [str(artifact)],
                stdout=stdout,
                stderr=stderr,
            )

        self.assertEqual(exit_code, 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("artifact_unreadable_or_oversized", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
