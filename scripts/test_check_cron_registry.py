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
                prompt=(
                    "PM contract: #879 is historical context only; no routine comments are routed there. "
                    "shadow-eval gate: gh tool - do not route issue comment to #879."
                )
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


class MonitorRegistrySplitBrainPolicyTests(unittest.TestCase):
    def test_parses_monitor_expected_cron_rows(self) -> None:
        prompt = """
Active expected cron jobs:
- `f66ed36d7be0` Screeps autonomous continuation worker — `8,28,48 * * * *`, deliver `discord:#task-queue`, model `gpt-5.5` / provider `openai-codex`.
- `1df5ef0c3835` Screeps runtime room alert text check — `1,16,31,46 * * * *`, deliver `discord:1497588512436785284`, model `deepseek-v4-flash` / provider `deepseek`.
"""

        parsed = cron.parse_monitor_expected_jobs(prompt)

        self.assertEqual(parsed["f66ed36d7be0"]["schedule"], "8,28,48 * * * *")
        self.assertEqual(parsed["f66ed36d7be0"]["model"], "gpt-5.5")
        self.assertEqual(parsed["f66ed36d7be0"]["provider"], "openai-codex")
        self.assertEqual(parsed["1df5ef0c3835"]["provider"], "deepseek")

    def test_flags_registry_monitor_provider_model_split_brain(self) -> None:
        expected = {
            "1df5ef0c3835": {
                "job": "Screeps runtime room alert text check",
                "schedule": "1,16,31,46 * * * *",
                "deliver": "discord:1497588512436785284",
                "provider": "openai-codex",
                "model": "gpt-5.5",
                "workdir": cron.NO_WORKDIR,
                "repeat": "forever",
                "criticality": "P0",
            }
        }
        live = {
            "75cedbb77150": {
                "name": "Screeps P0 agent operations monitor",
                "prompt": (
                    "Active expected cron jobs:\n"
                    "- `1df5ef0c3835` Screeps runtime room alert text check — "
                    "`1,16,31,46 * * * *`, deliver `discord:1497588512436785284`, "
                    "model `deepseek-v4-flash` / provider `deepseek`.\n"
                ),
            },
            "1df5ef0c3835": {
                "name": "Screeps runtime room alert text check",
                "enabled": True,
                "state": "scheduled",
                "schedule": "1,16,31,46 * * * *",
                "deliver": "discord:1497588512436785284",
                "provider": "deepseek",
                "model": "deepseek-v4-flash",
                "repeat": "forever",
            },
        }

        violations = cron.validate_monitor_registry_split_brain(expected, live)
        result = cron.compare(expected, live, policy_violations=violations)

        self.assertEqual(result["status"], "FAIL", result)
        self.assertTrue(
            any(item["pattern"] == "monitor_registry_provider_model_conflict" for item in result["policy_violations"]),
            result,
        )
        self.assertTrue(any(item["field"] == "provider" for item in result["policy_violations"]), result)
        self.assertTrue(any(item["field"] == "model" for item in result["policy_violations"]), result)

    def test_flags_monitor_expected_job_missing_from_registry(self) -> None:
        expected: dict[str, dict[str, str | None]] = {}
        live = {
            "75cedbb77150": {
                "name": "Screeps P0 agent operations monitor",
                "prompt": (
                    "Active expected cron jobs:\n"
                    "- `deadbeefcafe` Retired stale cron — `*/5 * * * *`, deliver `discord:#task-queue`, "
                    "model `gpt-5.5` / provider `openai-codex`.\n"
                ),
            },
        }

        violations = cron.validate_monitor_registry_split_brain(expected, live)

        self.assertTrue(
            any(
                item["id"] == "deadbeefcafe"
                and item["field"] == "presence"
                and item["pattern"] == "monitor_registry_expectation_conflict"
                for item in violations
            ),
            violations,
        )


class IssueCommentSinkPolicyTests(unittest.TestCase):
    def test_flags_fixed_closed_loop_issue_comment_fanout(self) -> None:
        live = {
            "loop-a": live_recurring_job()
            | {
                "name": "Loop A ledger",
                "prompt": "Comment #893 and the exact current atomic issue(s) with concise markdown.",
            }
        }

        violations = cron.validate_issue_comment_sink_policy(live)

        self.assertTrue(
            any(item["pattern"] == "fixed_issue_comment_fanout" for item in violations),
            violations,
        )

    def test_flags_fanout_after_no_routine_comments_policy_preamble(self) -> None:
        live = {
            "loop-a": live_recurring_job()
            | {
                "name": "Loop A ledger",
                "prompt": (
                    "No routine comments are routed to historical ledgers. "
                    "Comment #893 and the exact current atomic issue(s) with concise markdown."
                ),
            }
        }

        violations = cron.validate_issue_comment_sink_policy(live)

        self.assertTrue(
            any(item["pattern"] == "fixed_issue_comment_fanout" for item in violations),
            violations,
        )
        self.assertTrue(
            any(item["pattern"] == "historical_issue_comment_target" for item in violations),
            violations,
        )

    def test_flags_gh_issue_comment_to_historical_or_closed_issue(self) -> None:
        live = {
            "loop-b": live_recurring_job()
            | {
                "name": "Loop B ledger",
                "prompt": "gh issue comment 893 --body-file /tmp/ledger.md",
            }
        }

        violations = cron.validate_issue_comment_sink_policy(live)

        self.assertTrue(
            any(item["pattern"] == "historical_issue_comment_target" for item in violations),
            violations,
        )

    def test_allows_same_phrase_historical_comment_prohibition(self) -> None:
        live = {
            "loop-b": live_recurring_job()
            | {
                "name": "Loop B ledger",
                "prompt": "Historical issue #893 is context only; do not comment #893.",
            }
        }

        violations = cron.validate_issue_comment_sink_policy(live)

        self.assertEqual(violations, [])

    def test_flags_fixed_source_issue_metadata_for_ledger_producers(self) -> None:
        live = {
            "loop-a": live_recurring_job()
            | {
                "name": "Loop A ledger",
                "prompt": "type=screeps-rl-training-execution-ledger, sourceIssue=#893, legacyContextIssue=#879",
            }
        }

        violations = cron.validate_issue_comment_sink_policy(live)

        self.assertTrue(
            any(item["pattern"] == "fixed_historical_source_issue" for item in violations),
            violations,
        )

    def test_flags_forbidden_sink_metadata_outside_prompt(self) -> None:
        live = {
            "loop-a": live_recurring_job()
            | {
                "name": "Loop A ledger",
                "prompt": "Issue 893 is historical context only. Routine producer output belongs in artifacts.",
                "ledger": {
                    "sourceIssue": "#893",
                    "tracking surfaces": "#893",
                },
            }
        }

        violations = cron.validate_issue_comment_sink_policy(live)

        metadata_violations = [item for item in violations if item["surface"] == "live job loop-a metadata"]
        self.assertTrue(
            any(item["pattern"] == "fixed_historical_source_issue" for item in metadata_violations),
            violations,
        )
        self.assertTrue(
            any(item["pattern"] == "fixed_historical_tracking_surface" for item in metadata_violations),
            violations,
        )

    def test_flags_historical_issue_as_tracking_surface(self) -> None:
        live = {
            "loop-a": live_recurring_job()
            | {
                "name": "Loop A ledger",
                "prompt": "Tracking surfaces: #893 (closed-loop ledgers), active Project Domain = RL flywheel.",
            }
        }

        violations = cron.validate_issue_comment_sink_policy(live)

        self.assertTrue(
            any(item["pattern"] == "fixed_historical_tracking_surface" for item in violations),
            violations,
        )

    def test_allows_project_first_history_and_material_atomic_comment_rule(self) -> None:
        live = {
            "steward": live_recurring_job()
            | {
                "name": "RL steward",
                "prompt": (
                    "Issue 893 is historical context only. Routine producer output belongs in "
                    "runtime-artifacts/rl-control-loop/. GitHub comments are allowed only when "
                    "one exact open atomic owner issue materially changes acceptance evidence, "
                    "blocker, status, or next action."
                ),
            }
        }

        violations = cron.validate_issue_comment_sink_policy(live)

        self.assertEqual(violations, [])


if __name__ == "__main__":
    unittest.main()
