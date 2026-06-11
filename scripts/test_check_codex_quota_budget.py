#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import check_codex_quota_budget as guard


NOW = datetime(2026, 6, 11, 12, 0, tzinfo=timezone.utc)
RESET_FUTURE = datetime(2026, 6, 12, 12, 0, tzinfo=timezone.utc)
RESET_PAST = datetime(2026, 6, 10, 12, 0, tzinfo=timezone.utc)


def write_registry(path: Path) -> None:
    path.write_text(
        "\n".join(
            [
                "# Test cron registry",
                "",
                "## Expected recurring cron jobs",
                "",
                "| Job | ID | Schedule | Delivery | Provider | Model | Workdir | Repeat | Criticality | Purpose |",
                "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
                (
                    "| Screeps autonomous continuation worker | `f66ed36d7be0` | `8,28,48 * * * *` | "
                    "`discord:#task-queue` | `openai-codex` | `gpt-5.5` | `/root/screeps` | "
                    "`high-horizon` | P0 | Dispatcher/reconciler for safe work lanes. |"
                ),
                (
                    "| Screeps runtime room alert text check | `1df5ef0c3835` | `1,16,31,46 * * * *` | "
                    "`discord:1497588512436785284` | `openai-codex` | `gpt-5.5` | `-` | "
                    "`forever` | P0 | Runtime alert/tactical response. |"
                ),
                (
                    "| Routine Codex maintenance lane | `routine-codex` | `0 * * * *` | `discord:#task-queue` | "
                    "`openai-codex` | `gpt-5.5` | `-` | `forever` | P1 | Non-P0 Codex work. |"
                ),
                (
                    "| DeepSeek fanout reporter | `deepseek-report` | `30 * * * *` | `discord:#dev-log` | "
                    "`deepseek` | `deepseek-v4-flash` | `-` | `forever` | P1 | Non-Codex reporting. |"
                ),
            ]
        )
        + "\n",
        encoding="utf-8",
    )


def expected_jobs() -> dict[str, dict[str, str | None]]:
    with tempfile.TemporaryDirectory() as tmpdir:
        registry = Path(tmpdir) / "registry.md"
        write_registry(registry)
        return guard.check_cron_registry.parse_registry(registry)


def quota_from_payload(used_percent: float, reset_at: datetime) -> guard.QuotaReadResult:
    payload = {
        "timestamp": NOW.isoformat().replace("+00:00", "Z"),
        "payload": {
            "type": "token_count",
            "rate_limits": {
                "primary": {
                    "used_percent": 1.0,
                    "window_minutes": 300,
                    "resets_at": int(RESET_FUTURE.timestamp()),
                },
                "secondary": {
                    "used_percent": used_percent,
                    "window_minutes": guard.DEFAULT_WEEKLY_WINDOW_MINUTES,
                    "resets_at": int(reset_at.timestamp()),
                },
            },
        },
    }
    snapshot, errors = guard.snapshot_from_mapping(payload, source="fixture")
    return guard.QuotaReadResult(snapshot, errors=errors)


class CodexQuotaBudgetGuardTests(unittest.TestCase):
    def test_parse_timestamp_rejects_out_of_range_numeric_epoch(self) -> None:
        self.assertIsNone(guard.parse_timestamp(10**20))

    def test_parse_timestamp_rejects_out_of_range_numeric_string_epoch(self) -> None:
        self.assertIsNone(guard.parse_timestamp(str(10**20)))

    def test_healthy_quota_allows_all_jobs(self) -> None:
        result = guard.evaluate_budget(expected_jobs(), quota_from_payload(used_percent=50.0, reset_at=RESET_FUTURE), now=NOW)

        self.assertEqual(result["status"], "ALLOW_ALL", result)
        self.assertEqual(result["quota"]["state"], "HEALTHY_QUOTA")
        self.assertEqual(result["summary"]["suppressedCount"], 0)
        self.assertTrue(all(item["decision"] == "ALLOW" for item in result["decisions"]))

    def test_low_quota_allows_p0_and_suppresses_non_p0_codex(self) -> None:
        result = guard.evaluate_budget(expected_jobs(), quota_from_payload(used_percent=93.0, reset_at=RESET_FUTURE), now=NOW)
        decisions = {item["id"]: item for item in result["decisions"]}

        self.assertEqual(result["status"], "SUPPRESSING", result)
        self.assertEqual(result["quota"]["state"], "LOW_QUOTA")
        self.assertEqual(decisions["f66ed36d7be0"]["decision"], "ALLOW")
        self.assertEqual(decisions["1df5ef0c3835"]["decision"], "ALLOW")
        self.assertEqual(decisions["routine-codex"]["decision"], "SUPPRESS")
        self.assertEqual(decisions["routine-codex"]["reason"], "low_quota")
        self.assertEqual(decisions["deepseek-report"]["decision"], "ALLOW")
        self.assertEqual(result["summary"]["suppressedJobIds"], ["routine-codex"])

    def test_reset_time_in_past_self_heals_stale_low_quota(self) -> None:
        result = guard.evaluate_budget(expected_jobs(), quota_from_payload(used_percent=99.0, reset_at=RESET_PAST), now=NOW)

        self.assertEqual(result["status"], "ALLOW_ALL", result)
        self.assertEqual(result["quota"]["state"], "RESET_ELAPSED")
        self.assertTrue(result["quota"]["resetElapsed"])
        self.assertEqual(result["quota"]["effectiveRemainingPercent"], 100.0)
        self.assertEqual(result["summary"]["suppressedCount"], 0)

    def test_missing_quota_data_fails_safe_with_clear_report(self) -> None:
        quota = guard.QuotaReadResult(None, errors=("no weekly quota telemetry found",))
        result = guard.evaluate_budget(expected_jobs(), quota, now=NOW)
        decisions = {item["id"]: item for item in result["decisions"]}

        self.assertEqual(result["status"], "UNKNOWN_QUOTA", result)
        self.assertEqual(result["quota"]["state"], "UNKNOWN_QUOTA")
        self.assertIn("no weekly quota telemetry found", result["quota"]["errors"])
        self.assertEqual(decisions["f66ed36d7be0"]["decision"], "ALLOW")
        self.assertEqual(decisions["routine-codex"]["decision"], "SUPPRESS")

    def test_malformed_quota_json_fails_safe_with_clear_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            quota_path = Path(tmpdir) / "quota.json"
            quota_path.write_text("{not-json", encoding="utf-8")

            quota = guard.load_quota_json(quota_path)
            result = guard.evaluate_budget(expected_jobs(), quota, now=NOW)

        self.assertEqual(result["status"], "UNKNOWN_QUOTA", result)
        self.assertTrue(any("quota JSON malformed" in error for error in result["quota"]["errors"]), result)
        self.assertEqual(result["summary"]["suppressedJobIds"], ["routine-codex"])

    def test_cross_cron_aggregate_decisions_are_emitted(self) -> None:
        result = guard.evaluate_budget(expected_jobs(), quota_from_payload(used_percent=91.0, reset_at=RESET_FUTURE), now=NOW)

        self.assertEqual(result["summary"]["totalJobs"], 4)
        self.assertEqual(result["summary"]["codexJobs"], 3)
        self.assertEqual(result["summary"]["protectedCodexJobs"], 2)
        self.assertEqual(result["summary"]["nonProtectedCodexJobs"], 1)
        self.assertEqual([item["id"] for item in result["decisions"]], [
            "1df5ef0c3835",
            "deepseek-report",
            "f66ed36d7be0",
            "routine-codex",
        ])

    def test_session_log_loader_uses_latest_weekly_quota_sample(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            session_log = Path(tmpdir) / "rollout-test.jsonl"
            records = [
                {
                    "timestamp": "2026-06-11T11:00:00Z",
                    "type": "event_msg",
                    "payload": {
                        "type": "token_count",
                        "rate_limits": {
                            "secondary": {
                                "used_percent": 30.0,
                                "window_minutes": guard.DEFAULT_WEEKLY_WINDOW_MINUTES,
                                "resets_at": int(RESET_FUTURE.timestamp()),
                            }
                        },
                    },
                },
                {
                    "timestamp": "2026-06-11T11:30:00Z",
                    "type": "event_msg",
                    "payload": {
                        "type": "token_count",
                        "rate_limits": {
                            "secondary": {
                                "used_percent": 92.0,
                                "window_minutes": guard.DEFAULT_WEEKLY_WINDOW_MINUTES,
                                "resets_at": int(RESET_FUTURE.timestamp()),
                            }
                        },
                    },
                },
            ]
            session_log.write_text("\n".join(json.dumps(record, sort_keys=True) for record in records) + "\n", encoding="utf-8")

            quota = guard.scan_session_log(session_log)
            result = guard.evaluate_budget(expected_jobs(), quota, now=NOW)

        self.assertIsNotNone(quota.snapshot)
        self.assertEqual(quota.snapshot.remaining_percent, 8.0)
        self.assertEqual(result["quota"]["state"], "LOW_QUOTA")
        self.assertEqual(result["summary"]["suppressedJobIds"], ["routine-codex"])


if __name__ == "__main__":
    unittest.main()
