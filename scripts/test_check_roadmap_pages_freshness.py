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
        "fetchErrors": [],
    }


def write_pages(repo_root: Path, *, generated_at: str, html_timestamp: str | None = None, github: Any = None) -> None:
    docs = repo_root / "docs"
    docs.mkdir(parents=True)
    data = {
        "generatedAt": generated_at,
        "generatedAtCst": "2026-05-23 12:00:00 CST",
        "github": live_github_snapshot() if github is None else github,
    }
    (docs / "roadmap-data.json").write_text(json.dumps(data), encoding="utf-8")
    (docs / "index.html").write_text(
        f"<html><body>Published {html_timestamp or generated_at}</body></html>",
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

        self.assertIn("generatedAt is not reflected", "\n".join(failures))

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
        self.assertIn("github.fetchErrors must be empty", failure_text)


if __name__ == "__main__":
    unittest.main()
