#!/usr/bin/env python3
"""Validate RL reward decision registry JSON files."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence


REQUIRED_FIELDS = (
    "rewardDecisionId",
    "title",
    "state",
    "linkedGitHubIssue",
    "linkedMetricEvidence",
    "linkedDashboardPanels",
    "problemStatement",
    "hypothesis",
    "currentRewardCoverage",
    "proposedChangeType",
    "component",
    "direction",
    "expectedBehaviorChange",
    "riskAndRegressions",
    "validationWindows",
    "acceptanceCriteria",
    "rollbackCriteria",
    "stewardDecision",
    "ownerDecision",
    "linkedPRs",
    "linkedTrainingRuns",
    "linkedPolicyEvaluations",
    "createdAt",
    "updatedAt",
)

SAFE_STATES = {
    "proposed",
    "owner_review",
    "approved_for_shadow",
    "training",
    "candidate_policy",
    "validating",
    "accepted",
    "rejected",
    "rolled_back",
}

UNSAFE_TRUE_KEYS = {
    "liveEffect",
    "officialMmoWrites",
    "officialMmoWritesAllowed",
    "officialMmoControl",
    "memoryWritesAllowed",
    "rawMemoryWritesAllowed",
    "rawCreepIntentControl",
    "spawnIntentControl",
    "constructionIntentControl",
    "marketIntentControl",
}

DEFAULT_DECISION_DIR = Path("docs/ops/examples/rl-reward-decisions")


@dataclass(frozen=True)
class ValidationError:
    path: Path
    message: str

    def format(self) -> str:
        return f"{self.path}: {self.message}"


def load_json_object(path: Path) -> tuple[dict[str, Any] | None, list[ValidationError]]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        return None, [ValidationError(path, f"invalid JSON: {error}")]
    except OSError as error:
        return None, [ValidationError(path, f"could not read file: {error}")]

    if not isinstance(loaded, dict):
        return None, [ValidationError(path, "top-level JSON value must be an object")]
    return loaded, []


def walk_json(value: Any, path: tuple[str, ...] = ()) -> Iterable[tuple[tuple[str, ...], Any]]:
    yield path, value
    if isinstance(value, dict):
        for key, nested in value.items():
            if isinstance(key, str):
                yield from walk_json(nested, (*path, key))
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            yield from walk_json(nested, (*path, str(index)))


def validate_payload(path: Path, payload: dict[str, Any]) -> list[ValidationError]:
    errors: list[ValidationError] = []

    missing = [field for field in REQUIRED_FIELDS if field not in payload]
    if missing:
        errors.append(ValidationError(path, "missing required fields: " + ", ".join(missing)))

    state = payload.get("state")
    if state not in SAFE_STATES:
        errors.append(
            ValidationError(
                path,
                f"state must be one of {', '.join(sorted(SAFE_STATES))}; got {state!r}",
            )
        )

    for nested_path, value in walk_json(payload):
        key = nested_path[-1] if nested_path else ""
        if key in UNSAFE_TRUE_KEYS and value is True:
            errors.append(ValidationError(path, f"unsafe true flag at {'.'.join(nested_path)}"))

    return errors


def validate_file(path: Path) -> list[ValidationError]:
    payload, errors = load_json_object(path)
    if payload is None:
        return errors
    return errors + validate_payload(path, payload)


def collect_json_files(paths: Sequence[Path]) -> list[Path]:
    files: list[Path] = []
    for path in paths:
        if path.is_dir():
            files.extend(sorted(candidate for candidate in path.rglob("*.json") if candidate.is_file()))
        elif path.is_file():
            files.append(path)
        else:
            files.append(path)
    return files


def validate_paths(paths: Sequence[Path]) -> list[ValidationError]:
    files = collect_json_files(paths)
    errors: list[ValidationError] = []

    if not files:
        return [ValidationError(paths[0] if paths else DEFAULT_DECISION_DIR, "no JSON files found")]

    for path in files:
        if not path.exists():
            errors.append(ValidationError(path, "path does not exist"))
            continue
        errors.extend(validate_file(path))
    return errors


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate RL reward decision JSON files.")
    parser.add_argument(
        "paths",
        nargs="*",
        type=Path,
        default=[DEFAULT_DECISION_DIR],
        help="Decision JSON file or directory to validate. Defaults to docs/ops/examples/rl-reward-decisions.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    paths: list[Path] = args.paths

    errors = validate_paths(paths)
    if errors:
        for error in errors:
            print(error.format(), file=sys.stderr)
        return 1

    file_count = len(collect_json_files(paths))
    print(f"validated {file_count} RL reward decision JSON file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
