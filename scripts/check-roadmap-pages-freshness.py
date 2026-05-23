#!/usr/bin/env python3
"""Check that committed GitHub Pages roadmap artifacts were recently generated."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence


DEFAULT_MAX_AGE_HOURS = 168.0


def parse_utc_timestamp(value: object) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("generatedAt is missing or not a string")
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def load_now(value: str | None) -> datetime:
    if value:
        return parse_utc_timestamp(value)
    return datetime.now(timezone.utc)


def check_pages_freshness(
    repo_root: Path,
    *,
    max_age_hours: float,
    now: datetime,
    require_live_github: bool = False,
) -> list[str]:
    failures: list[str] = []
    data_path = repo_root / "docs" / "roadmap-data.json"
    html_path = repo_root / "docs" / "index.html"

    try:
        data = json.loads(data_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return [f"{data_path}: failed to read roadmap data: {error}"]
    if not isinstance(data, dict):
        return [f"{data_path}: roadmap data root must be an object"]

    try:
        generated_at = parse_utc_timestamp(data.get("generatedAt"))
    except ValueError as error:
        return [f"{data_path}: {error}"]

    age_hours = (now - generated_at).total_seconds() / 3600
    if age_hours < -0.1:
        failures.append(f"{data_path}: generatedAt {data.get('generatedAt')} is in the future")
    if age_hours > max_age_hours:
        failures.append(
            f"{data_path}: generatedAt {data.get('generatedAt')} is {age_hours:.1f}h old; "
            f"maximum allowed age is {max_age_hours:.1f}h"
        )

    try:
        html = html_path.read_text(encoding="utf-8")
    except OSError as error:
        failures.append(f"{html_path}: failed to read HTML artifact: {error}")
    else:
        visible_timestamps = [str(data.get("generatedAt") or ""), str(data.get("generatedAtCst") or "")]
        if not any(timestamp and timestamp in html for timestamp in visible_timestamps):
            failures.append(f"{html_path}: generatedAt is not reflected in the committed HTML artifact")

    if require_live_github:
        failures.extend(check_live_github_snapshot(data, data_path))

    return failures


def check_live_github_snapshot(data: dict[str, object], data_path: Path) -> list[str]:
    failures: list[str] = []
    github = data.get("github")
    if not isinstance(github, dict):
        return [f"{data_path}: github snapshot is missing or not an object"]

    if github.get("fetched") is not True:
        failures.append(f"{data_path}: github.fetched must be true for a live Pages refresh")
    if github.get("sourceMode") != "live":
        failures.append(f"{data_path}: github.sourceMode must be live, got {github.get('sourceMode')!r}")
    if github.get("projectItemsSource") != "live":
        failures.append(
            f"{data_path}: github.projectItemsSource must be live, got {github.get('projectItemsSource')!r}"
        )
    fetch_errors = github.get("fetchErrors")
    if not isinstance(fetch_errors, list):
        failures.append(f"{data_path}: github.fetchErrors must be a list")
    elif fetch_errors:
        failures.append(f"{data_path}: github.fetchErrors must be empty for a live Pages refresh")
    return failures


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", nargs="?", default=".", help="Repository root. Default: current directory.")
    parser.add_argument(
        "--max-age-hours",
        type=float,
        default=DEFAULT_MAX_AGE_HOURS,
        help=f"Maximum allowed docs/roadmap-data.json age. Default: {DEFAULT_MAX_AGE_HOURS:g}.",
    )
    parser.add_argument("--now", help="UTC reference timestamp for deterministic checks.")
    parser.add_argument(
        "--require-live-github",
        action="store_true",
        help="Require live GitHub issue, PR, and Project data in docs/roadmap-data.json.",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    repo_root = Path(args.repo).resolve()
    now = load_now(args.now)
    failures = check_pages_freshness(
        repo_root,
        max_age_hours=args.max_age_hours,
        now=now,
        require_live_github=args.require_live_github,
    )
    if failures:
        print("Roadmap Pages freshness check failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1
    print("Roadmap Pages freshness check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
