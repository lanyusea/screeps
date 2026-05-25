#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def load_checker_module() -> Any:
    module_path = Path(__file__).with_name("check-roadmap-pages-freshness.py")
    spec = importlib.util.spec_from_file_location("check_roadmap_pages_freshness", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load check-roadmap-pages-freshness.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


checker = load_checker_module()


def live_github_snapshot() -> dict[str, Any]:
    return {
        "fetched": True,
        "sourceMode": "live",
        "projectItemsSource": "live",
        "projectItemsCompleteness": {"complete": True, "returnedCount": 1332, "totalCount": 1332, "limit": 2000},
        "fetchErrors": [],
    }


def write_pages(repo_root: Path, *, generated_at: str, html_timestamp: str | None = None, github: Any = None) -> None:
    docs = repo_root / "docs"
    docs.mkdir(parents=True)
    generated_at_cst = "2026-05-23T12:00:00+08:00"
    data = {
        "generatedAt": generated_at,
        "generatedAtCst": generated_at_cst,
        "github": live_github_snapshot() if github is None else github,
    }
    (docs / "roadmap-data.json").write_text(json.dumps(data), encoding="utf-8")
    timestamp_text = html_timestamp if html_timestamp is not None else f"{generated_at} {generated_at_cst}"
    (docs / "index.html").write_text(
        f"<html><body>Published {timestamp_text}</body></html>",
        encoding="utf-8",
    )


class RoadmapPagesFreshnessTests(unittest.TestCase):
    def test_recent_pages_with_live_github_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            write_pages(repo_root, generated_at="2026-05-23T04:00:00Z")

            failures = checker.check_pages_freshness(
                repo_root,
                max_age_hours=168,
                now=datetime(2026, 5, 23, 5, tzinfo=timezone.utc),
                require_live_github=True,
            )

        self.assertEqual(failures, [])

    def test_stale_generated_at_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            write_pages(repo_root, generated_at="2026-05-01T00:00:00Z")

            failures = checker.check_pages_freshness(
                repo_root,
                max_age_hours=168,
                now=datetime(2026, 5, 23, tzinfo=timezone.utc),
            )

        self.assertIn("maximum allowed age is 168.0h", "\n".join(failures))

    def test_html_must_reflect_generated_timestamp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            write_pages(
                repo_root,
                generated_at="2026-05-23T04:00:00Z",
                html_timestamp="2026-05-22T04:00:00Z",
            )

            failures = checker.check_pages_freshness(
                repo_root,
                max_age_hours=168,
                now=datetime(2026, 5, 23, 5, tzinfo=timezone.utc),
            )

        self.assertIn("generatedAt", "\n".join(failures))

    def test_html_must_reflect_generated_cst_timestamp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            write_pages(
                repo_root,
                generated_at="2026-05-23T04:00:00Z",
                html_timestamp="2026-05-23T04:00:00Z",
            )

            failures = checker.check_pages_freshness(
                repo_root,
                max_age_hours=168,
                now=datetime(2026, 5, 23, 5, tzinfo=timezone.utc),
            )

        self.assertIn("generatedAtCst", "\n".join(failures))

    def test_require_live_github_rejects_cached_or_error_snapshots(self) -> None:
        stale_github = {
            "fetched": False,
            "sourceMode": "cached",
            "projectItemsSource": "cached",
            "fetchErrors": [{"source": "project", "message": "command failed"}],
        }
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            write_pages(repo_root, generated_at="2026-05-23T04:00:00Z", github=stale_github)

            failures = checker.check_pages_freshness(
                repo_root,
                max_age_hours=168,
                now=datetime(2026, 5, 23, 5, tzinfo=timezone.utc),
                require_live_github=True,
            )

        failure_text = "\n".join(failures)
        self.assertIn("github.fetched must be true", failure_text)
        self.assertIn("github.sourceMode must be live", failure_text)
        self.assertIn("github.projectItemsSource must be live", failure_text)
        self.assertIn("github.projectItemsCompleteness must be present", failure_text)
        self.assertIn("github.fetchErrors must be empty", failure_text)

    def test_require_live_github_rejects_incomplete_project_metadata(self) -> None:
        github = live_github_snapshot()
        github["projectItemsCompleteness"] = {
            "complete": False,
            "returnedCount": 500,
            "totalCount": 1332,
            "limit": 500,
        }
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            write_pages(repo_root, generated_at="2026-05-23T04:00:00Z", github=github)

            failures = checker.check_pages_freshness(
                repo_root,
                max_age_hours=168,
                now=datetime(2026, 5, 23, 5, tzinfo=timezone.utc),
                require_live_github=True,
            )

        self.assertIn("github.projectItemsCompleteness.complete must be true", "\n".join(failures))


if __name__ == "__main__":
    unittest.main()
