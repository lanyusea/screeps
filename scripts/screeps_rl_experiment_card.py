#!/usr/bin/env python3
"""Generate and validate offline RL experiment cards for Screeps strategy work."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TextIO


TRAINING_APPROACHES = ("bandit", "evolutionary", "policy_gradient")
DATASET_RUN_ID_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
COMMIT_RE = re.compile(r"^[0-9a-fA-F]{7,64}$")
ISO_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
DRY_RUN_DATASET_RUN_ID = "rl-dry-run-000000000000"
SAFETY_FALSE_FIELDS = ("liveEffect", "officialMmoWrites", "officialMmoWritesAllowed")
SAFETY_TRUE_FIELDS = ("ood_rejection", "conservative_actions_only")

JsonObject = dict[str, Any]


class CardValidationError(ValueError):
    """Raised when an experiment card fails the safety or schema contract."""


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


def git_commit(repo_root: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except (OSError, subprocess.CalledProcessError):
        return "0" * 40
    commit = result.stdout.strip()
    return commit if commit else "0" * 40


def validate_dataset_run_id(run_id: str) -> None:
    if not DATASET_RUN_ID_RE.fullmatch(run_id) or run_id in {".", ".."}:
        raise CardValidationError("dataset_run_id may contain only letters, numbers, dot, underscore, and hyphen")


def validate_code_commit(commit: str) -> None:
    if not COMMIT_RE.fullmatch(commit):
        raise CardValidationError("code_commit must be a hexadecimal commit SHA prefix or full SHA")


def validate_created_at(created_at: str) -> None:
    if not ISO_TIMESTAMP_RE.fullmatch(created_at):
        raise CardValidationError("created_at must be an ISO UTC timestamp like 2026-05-03T00:00:00Z")


def reward_model() -> JsonObject:
    return {
        "component_order": ["reliability", "territory", "resources", "kills"],
        "component_weights": {
            "alpha_reliability": 1000000000,
            "beta_territory": 1000000,
            "gamma_resources": 1000,
            "delta_kills": 1,
        },
        "formula": "R = alpha*R_reliability + beta*R_territory + gamma*R_resources + delta*R_kills; alpha >> beta >> gamma >> delta",
        "scalar_weighted_sum_authorized": False,
        "type": "lexicographic",
    }


def safety_block() -> JsonObject:
    return {
        "conservative_actions_only": True,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "ood_rejection": True,
    }


def build_card(
    *,
    dataset_run_id: str,
    code_commit: str,
    training_approach: str,
    created_at: str,
) -> JsonObject:
    validate_dataset_run_id(dataset_run_id)
    validate_code_commit(code_commit)
    validate_created_at(created_at)
    if training_approach not in TRAINING_APPROACHES:
        raise CardValidationError(f"training_approach must be one of: {', '.join(TRAINING_APPROACHES)}")

    commit_prefix = code_commit[:12].lower()
    card = {
        "card_id": f"rl-exp-{dataset_run_id}-{commit_prefix}",
        "code_commit": code_commit.lower(),
        "created_at": created_at,
        "dataset_run_id": dataset_run_id,
        "reward_model": reward_model(),
        "safety": safety_block(),
        "status": "shadow",
        "training_approach": training_approach,
    }
    validate_card(card)
    return card


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise CardValidationError(f"could not read {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise CardValidationError(f"{path} is not valid JSON: {error}") from error


def validate_card(raw: Any) -> None:
    if not isinstance(raw, dict):
        raise CardValidationError("card must be a JSON object")

    required_fields = (
        "card_id",
        "dataset_run_id",
        "code_commit",
        "training_approach",
        "reward_model",
        "safety",
        "created_at",
        "status",
    )
    for field in required_fields:
        if field not in raw:
            raise CardValidationError(f"missing required field: {field}")

    dataset_run_id = require_string(raw, "dataset_run_id")
    code_commit = require_string(raw, "code_commit")
    created_at = require_string(raw, "created_at")
    card_id = require_string(raw, "card_id")
    training_approach = require_string(raw, "training_approach")

    validate_dataset_run_id(dataset_run_id)
    validate_code_commit(code_commit)
    validate_created_at(created_at)
    if training_approach not in TRAINING_APPROACHES:
        raise CardValidationError(f"training_approach must be one of: {', '.join(TRAINING_APPROACHES)}")
    if raw.get("status") != "shadow":
        raise CardValidationError("status must be shadow")

    expected_card_id = f"rl-exp-{dataset_run_id}-{code_commit[:12].lower()}"
    if card_id != expected_card_id:
        raise CardValidationError(f"card_id must be {expected_card_id}")

    validate_safety(raw)
    validate_reward_model(raw.get("reward_model"))


def require_string(raw: JsonObject, field: str) -> str:
    value = raw.get(field)
    if not isinstance(value, str) or not value:
        raise CardValidationError(f"{field} must be a non-empty string")
    return value


def validate_safety(raw: JsonObject) -> None:
    safety = raw.get("safety")
    if not isinstance(safety, dict):
        raise CardValidationError("safety must be a JSON object")

    for field in SAFETY_FALSE_FIELDS:
        if safety.get(field) is not False:
            raise CardValidationError(f"safety.{field} must be false")
        if field in raw and raw[field] is not False:
            raise CardValidationError(f"{field} must be false when present")

    for field in SAFETY_TRUE_FIELDS:
        if safety.get(field) is not True:
            raise CardValidationError(f"safety.{field} must be true")


def validate_reward_model(raw: Any) -> None:
    if not isinstance(raw, dict):
        raise CardValidationError("reward_model must be a JSON object")
    if raw.get("type") != "lexicographic":
        raise CardValidationError("reward_model.type must be lexicographic")
    if raw.get("component_order") != ["reliability", "territory", "resources", "kills"]:
        raise CardValidationError("reward_model.component_order must preserve reliability, territory, resources, kills")
    weights = raw.get("component_weights")
    if not isinstance(weights, dict):
        raise CardValidationError("reward_model.component_weights must be a JSON object")
    required_weights = ("alpha_reliability", "beta_territory", "gamma_resources", "delta_kills")
    for field in required_weights:
        if not isinstance(weights.get(field), int):
            raise CardValidationError(f"reward_model.component_weights.{field} must be an integer")
    if not (
        weights["alpha_reliability"]
        > weights["beta_territory"]
        > weights["gamma_resources"]
        > weights["delta_kills"]
    ):
        raise CardValidationError("reward_model weights must be strictly lexicographic")
    if raw.get("scalar_weighted_sum_authorized") is not False:
        raise CardValidationError("reward_model.scalar_weighted_sum_authorized must be false")


def write_output(payload: Any, output: Path | None, stdout: TextIO) -> None:
    text = canonical_json(payload)
    if output is None:
        stdout.write(text)
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(text, encoding="utf-8")


def validation_summary(card: JsonObject) -> JsonObject:
    safety = card.get("safety") if isinstance(card.get("safety"), dict) else {}
    return {
        "card_id": card.get("card_id"),
        "dataset_run_id": card.get("dataset_run_id"),
        "ok": True,
        "safety": {
            field: safety.get(field)
            for field in (*SAFETY_FALSE_FIELDS, *SAFETY_TRUE_FIELDS)
        },
        "status": card.get("status"),
    }


def run_self_test(stdout: TextIO) -> int:
    commit = "a" * 40
    created_at = "2026-05-03T00:00:00Z"
    card = build_card(
        dataset_run_id="rl-self-test-000000000000",
        code_commit=commit,
        training_approach="bandit",
        created_at=created_at,
    )
    with tempfile.TemporaryDirectory() as temp_dir:
        card_path = Path(temp_dir) / "experiment_card.json"
        card_path.write_text(canonical_json(card), encoding="utf-8")
        loaded = load_json(card_path)
        validate_card(loaded)
        if canonical_json(card) != canonical_json(loaded):
            raise CardValidationError("round-trip changed canonical JSON")

    stdout.write(canonical_json({"card_id": card["card_id"], "ok": True, "validated": True}))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate or validate offline/shadow Screeps RL experiment cards.",
    )
    parser.add_argument(
        "command",
        nargs="?",
        choices=("self-test",),
        help="Run the built-in round-trip validation self-test.",
    )
    parser.add_argument(
        "--dataset-run-id",
        help=f"Dataset run ID to link. Required unless --dry-run is used. Dry-run default: {DRY_RUN_DATASET_RUN_ID}.",
    )
    parser.add_argument(
        "--code-commit",
        help="Code commit SHA to link. Defaults to git rev-parse HEAD.",
    )
    parser.add_argument(
        "--training-approach",
        choices=TRAINING_APPROACHES,
        default="bandit",
        help="Training approach recorded in the card. Default: bandit.",
    )
    parser.add_argument(
        "--created-at",
        help="ISO UTC timestamp to record. Defaults to current UTC second.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Generate a synthetic offline card without requiring a real dataset run artifact.",
    )
    parser.add_argument(
        "--validate",
        action="store_true",
        help="Validate an existing card JSON instead of generating one.",
    )
    parser.add_argument(
        "--input",
        type=Path,
        help="Input card JSON for --validate.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Write generated card or validation summary to this path instead of stdout.",
    )
    return parser


def main(
    argv: list[str] | None = None,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
    repo_root: Path | None = None,
) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    repo = (repo_root or Path.cwd()).expanduser().resolve()

    try:
        if args.command == "self-test":
            return run_self_test(stdout)

        if args.validate:
            if args.input is None:
                raise CardValidationError("--validate requires --input")
            loaded = load_json(args.input)
            validate_card(loaded)
            write_output(validation_summary(loaded), args.output, stdout)
            return 0

        dataset_run_id = args.dataset_run_id
        if dataset_run_id is None:
            if not args.dry_run:
                raise CardValidationError("--dataset-run-id is required unless --dry-run is used")
            dataset_run_id = DRY_RUN_DATASET_RUN_ID

        card = build_card(
            dataset_run_id=dataset_run_id,
            code_commit=args.code_commit or git_commit(repo),
            training_approach=args.training_approach,
            created_at=args.created_at or utc_now_iso(),
        )
        write_output(card, args.output, stdout)
        return 0
    except CardValidationError as error:
        stderr.write(f"error: {error}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main(repo_root=Path(__file__).resolve().parent.parent))
