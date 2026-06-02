#!/usr/bin/env python3
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import check_cron_registry as cron


def expected_recurring_job() -> dict[str, str]:
    return {
        "job": "Screeps recurring contract job",
        "schedule": "*/30 * * * *",
        "deliver": "discord:#task-queue",
        "provider": "openai-codex",
        "model": "gpt-5.5",
        "workdir": cron.NO_WORKDIR,
        "repeat": "forever",
        "criticality": "P1",
    }


def live_recurring_job() -> dict[str, object]:
    return {
        "name": "Screeps recurring contract job",
        "enabled": True,
        "state": "scheduled",
        "schedule": "*/30 * * * *",
        "deliver": "discord:#task-queue",
        "provider": "openai-codex",
        "model": "gpt-5.5",
        "repeat": "forever",
    }


def expected_shadow_eval_job() -> dict[str, str]:
    return {
        "job": cron.SHADOW_EVAL_JOB_NAME,
        "schedule": "5 * * * *",
        "deliver": "discord:#task-queue",
        "provider": "deepseek",
        "model": "deepseek-v4-flash",
        "workdir": cron.NO_WORKDIR,
        "repeat": "high-horizon",
        "criticality": "P1",
    }


def live_shadow_eval_job(**extra: object) -> dict[str, object]:
    job: dict[str, object] = {
        "name": cron.SHADOW_EVAL_JOB_NAME,
        "enabled": True,
        "state": "scheduled",
        "schedule": "5 * * * *",
        "deliver": "discord:#task-queue",
        "provider": "deepseek",
        "model": "deepseek-v4-flash",
        "repeat": {"times": 999999, "completed": 0},
    }
    job.update(extra)
    return job


class CronRegistryCompareTests(unittest.TestCase):
    def test_compare_ignores_unexpected_live_one_shot_jobs(self) -> None:
        expected = {"recurring-job": expected_recurring_job()}
        live = {
            "recurring-job": live_recurring_job(),
            "one-shot-migration": {
                "name": "DeepSeek one-shot migration",
                "enabled": True,
                "state": "scheduled",
                "schedule": "at 2026-05-23 12:00",
                "deliver": "local",
                "provider": "deepseek",
                "model": "deepseek-v4-flash",
                "repeat": {"times": 1, "completed": 0},
            },
        }

        result = cron.compare(expected, live)

        self.assertEqual(result["status"], "PASS", result)
        self.assertEqual(result["unexpected_live"], [])
        self.assertEqual(
            [item["id"] for item in result.get("ignored_one_shot_live", [])],
            ["one-shot-migration"],
        )

    def test_compare_ignores_unexpected_live_one_shot_repeat_string(self) -> None:
        expected = {"recurring-job": expected_recurring_job()}
        live = {
            "recurring-job": live_recurring_job(),
            "one-shot-repeat-string": {
                "name": "DeepSeek one-shot migration",
                "enabled": True,
                "state": "scheduled",
                "schedule": "at 2026-05-23 12:00",
                "deliver": "local",
                "provider": "deepseek",
                "model": "deepseek-v4-flash",
                "repeat": "1/1",
            },
        }

        result = cron.compare(expected, live)

        self.assertEqual(result["status"], "PASS", result)
        self.assertEqual(result["unexpected_live"], [])
        self.assertEqual(
            [item["id"] for item in result.get("ignored_one_shot_live", [])],
            ["one-shot-repeat-string"],
        )

    def test_compare_still_flags_unexpected_recurring_jobs(self) -> None:
        expected = {"recurring-job": expected_recurring_job()}
        live = {
            "recurring-job": live_recurring_job(),
            "unexpected-recurring": {
                "name": "Unexpected recurring worker",
                "enabled": True,
                "state": "scheduled",
                "schedule": "*/5 * * * *",
                "deliver": "discord:#task-queue",
                "provider": "openai-codex",
                "model": "gpt-5.5",
                "repeat": "forever",
            },
        }

        result = cron.compare(expected, live)

        self.assertEqual(result["status"], "FAIL", result)
        self.assertEqual(
            [item["id"] for item in result["unexpected_live"]],
            ["unexpected-recurring"],
        )


class ShadowEvalNoUmbrellaPolicyTests(unittest.TestCase):
    def test_shadow_eval_policy_flags_legacy_output_status(self) -> None:
        expected = {cron.SHADOW_EVAL_JOB_ID: expected_shadow_eval_job()}
        live = {cron.SHADOW_EVAL_JOB_ID: live_shadow_eval_job()}
        violations = cron.validate_shadow_eval_no_umbrella(
            live,
            source_path=None,
            text_surfaces={
                "shadow-eval output fixture": (
                    "gate_status=ok\n"
                    "github_issue_879_comment=posted https://github.com/lanyusea/screeps/issues/879#issuecomment-1\n"
                )
            },
        )

        result = cron.compare(expected, live, policy_violations=violations)

        self.assertEqual(result["status"], "FAIL", result)
        self.assertTrue(
            any(item["pattern"] == "legacy_github_issue_879_status" for item in result["policy_violations"]),
            result,
        )

    def test_shadow_eval_policy_flags_live_issue_879_comment_routing(self) -> None:
        expected = {cron.SHADOW_EVAL_JOB_ID: expected_shadow_eval_job()}
        live = {
            cron.SHADOW_EVAL_JOB_ID: live_shadow_eval_job(
                prompt='routine route: gh issue comment 879 --body-file "$artifact"'
            )
        }
        violations = cron.validate_shadow_eval_no_umbrella(live, source_path=None)

        result = cron.compare(expected, live, policy_violations=violations)

        self.assertEqual(result["status"], "FAIL", result)
        self.assertTrue(
            any(item["pattern"] == "gh_issue_comment_879" for item in result["policy_violations"]),
            result,
        )

    def test_shadow_eval_policy_flags_issue_879_url_and_api_routes(self) -> None:
        expected = {cron.SHADOW_EVAL_JOB_ID: expected_shadow_eval_job()}
        live = {cron.SHADOW_EVAL_JOB_ID: live_shadow_eval_job()}
        violations = cron.validate_shadow_eval_no_umbrella(
            live,
            source_path=None,
            text_surfaces={
                "shadow-eval artifact fixture": (
                    "posted_url=https://github.com/lanyusea/screeps/issues/879#issuecomment-1\n"
                    "api_route=https://api.github.com/repos/lanyusea/screeps/issues/879/comments\n"
                )
            },
        )

        result = cron.compare(expected, live, policy_violations=violations)

        self.assertEqual(result["status"], "FAIL", result)
        self.assertEqual(
            sum(item["pattern"] == "issue_879_url_or_api_route" for item in result["policy_violations"]),
            2,
            result,
        )

    def test_shadow_eval_policy_allows_current_skipped_no_atomic_issue_status(self) -> None:
        expected = {cron.SHADOW_EVAL_JOB_ID: expected_shadow_eval_job()}
        live = {
            cron.SHADOW_EVAL_JOB_ID: live_shadow_eval_job(
                prompt="emit github_comment=skipped_no_atomic_issue"
            )
        }
        violations = cron.validate_shadow_eval_no_umbrella(
            live,
            source_path=None,
            text_surfaces={
                "shadow-eval source fixture": (
                    'github_comment_status = "skipped_no_atomic_issue"\n'
                    'print("github_comment=skipped_no_atomic_issue")\n'
                )
            },
        )

        result = cron.compare(expected, live, policy_violations=violations)

        self.assertEqual(result["status"], "PASS", result)
        self.assertEqual(result["policy_violations"], [])

    def test_shadow_eval_policy_ignores_generic_no_umbrella_context_outside_routing_path(self) -> None:
        expected = {
            "recurring-job": expected_recurring_job(),
            cron.SHADOW_EVAL_JOB_ID: expected_shadow_eval_job(),
        }
        live = {
            "recurring-job": live_recurring_job()
            | {"prompt": "PM contract: #879 is historical context only; use atomic issues."},
            cron.SHADOW_EVAL_JOB_ID: live_shadow_eval_job(
                prompt="PM contract: #879 is historical context only; no routine comments are routed there."
            ),
        }
        violations = cron.validate_shadow_eval_no_umbrella(live, source_path=None)

        result = cron.compare(expected, live, policy_violations=violations)

        self.assertEqual(result["status"], "PASS", result)
        self.assertEqual(result["policy_violations"], [])

    def test_shadow_eval_policy_skips_absent_source_path(self) -> None:
        expected = {cron.SHADOW_EVAL_JOB_ID: expected_shadow_eval_job()}
        live = {cron.SHADOW_EVAL_JOB_ID: live_shadow_eval_job()}

        with tempfile.TemporaryDirectory() as tmpdir:
            missing_source = Path(tmpdir) / "missing-shadow-eval-source.py"
            violations = cron.validate_shadow_eval_no_umbrella(live, source_path=missing_source)

        result = cron.compare(expected, live, policy_violations=violations)

        self.assertEqual(result["status"], "PASS", result)
        self.assertEqual(result["policy_violations"], [])


if __name__ == "__main__":
    unittest.main()
