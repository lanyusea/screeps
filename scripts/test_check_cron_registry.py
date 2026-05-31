#!/usr/bin/env python3
from __future__ import annotations

import sys
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


if __name__ == "__main__":
    unittest.main()
