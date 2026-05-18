#!/usr/bin/env python3
"""Generate and validate offline RL experiment cards for Screeps strategy work."""

from __future__ import annotations

import argparse
import json
import math
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
STRATEGY_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]+$")
DRY_RUN_DATASET_RUN_ID = "rl-dry-run-000000000000"
SAFETY_FALSE_FIELDS = ("liveEffect", "officialMmoWrites", "officialMmoWritesAllowed")
SAFETY_TRUE_FIELDS = ("ood_rejection", "conservative_actions_only")
LOOP_A_CARD_SUPPLY_TYPE = "screeps-rl-loop-a-card-supply"
LOOP_A_CARD_SUPPLY_CONSUMER = "loop-a-policy-gradient"
LOOP_A_CARD_SUPPLY_AVAILABLE = "available"
LOOP_A_CARD_SUPPLY_CONSUMED = "consumed"
LOOP_A_CARD_SUPPLY_STATES = (LOOP_A_CARD_SUPPLY_AVAILABLE, LOOP_A_CARD_SUPPLY_CONSUMED)
DEFAULT_STRATEGY_VARIANTS = (
    "construction-priority.incumbent.v1",
    "construction-priority.territory-shadow.v1",
    "expansion-remote.incumbent.v1",
    "expansion-remote.territory-shadow.v1",
)
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SIMULATION_CODE_PATH = REPO_ROOT / "prod" / "dist" / "main.js"
DEFAULT_SIMULATION_MAP_SOURCE_FILE = REPO_ROOT / "maps" / "map-0b6758af.json"
DEFAULT_SIMULATION_OUT_DIR = REPO_ROOT / "runtime-artifacts" / "rl-simulator"
DEFAULT_EXPERIMENT_CARD_DIR = REPO_ROOT / "runtime-artifacts" / "rl-experiment-cards"
DEFAULT_DATASET_GATE_ROOT = REPO_ROOT / "runtime-artifacts" / "rl-dataset-gates"
DEFAULT_TRAINING_REPORT_ROOT = REPO_ROOT / "runtime-artifacts" / "rl-training"
DEFAULT_LOOP_A_LOCAL_FALLBACK_CARD_PATH = DEFAULT_EXPERIMENT_CARD_DIR / "experiment_card.json"
DEFAULT_STRATEGY_REGISTRY_PATH = REPO_ROOT / "prod" / "src" / "strategy" / "strategyRegistry.ts"
DEFAULT_SIMULATION_TICKS = 50
DEFAULT_SIMULATION_REPETITIONS = 1
DEFAULT_SIMULATION_WORKERS = 1
POLICY_GRADIENT_SIMULATION_TICKS = 100
POLICY_GRADIENT_SIMULATION_REPETITIONS = 5
LOOP_A_LOCAL_FALLBACK_TICKS = 200
LOOP_A_LOCAL_FALLBACK_REPETITIONS = 5
LOOP_A_LOCAL_FALLBACK_WORKERS = 5

JsonObject = dict[str, Any]

CONSTRUCTION_PRIORITY_FAMILY = "construction-priority"
CONSTRUCTION_PRIORITY_REGISTRY_IDS = (
    "construction-priority.incumbent.v1",
    "construction-priority.territory-shadow.v1",
)
CONSTRUCTION_PRIORITY_KNOBS: tuple[JsonObject, ...] = (
    {
        "name": "baseScoreWeight",
        "min": 0,
        "max": 3,
        "step": 0.1,
        "description": "Weight applied to the already-emitted incumbent construction score.",
    },
    {
        "name": "territorySignalWeight",
        "min": 0,
        "max": 30,
        "step": 1,
        "description": "Weight for territory-first expected KPI signals.",
    },
    {
        "name": "resourceSignalWeight",
        "min": 0,
        "max": 30,
        "step": 1,
        "description": "Weight for resource-scaling expected KPI signals.",
    },
    {
        "name": "killSignalWeight",
        "min": 0,
        "max": 30,
        "step": 1,
        "description": "Weight for enemy-kill or defense-posture signals.",
    },
    {
        "name": "riskPenalty",
        "min": 0,
        "max": 30,
        "step": 1,
        "description": "Penalty per visible risk or blocking precondition.",
    },
)
CONSTRUCTION_PRIORITY_KNOB_NAMES = tuple(str(knob["name"]) for knob in CONSTRUCTION_PRIORITY_KNOBS)
CONSTRUCTION_PRIORITY_PARAMETER_LIMITS = {
    str(knob["name"]): (float(knob["min"]), float(knob["max"])) for knob in CONSTRUCTION_PRIORITY_KNOBS
}
CONSTRUCTION_PRIORITY_FALLBACK_DEFAULTS: dict[str, JsonObject] = {
    "construction-priority.incumbent.v1": {
        "baseScoreWeight": 1,
        "territorySignalWeight": 6,
        "resourceSignalWeight": 4,
        "killSignalWeight": 6,
        "riskPenalty": 4,
    },
    "construction-priority.territory-shadow.v1": {
        "baseScoreWeight": 1,
        "territorySignalWeight": 22,
        "resourceSignalWeight": 3,
        "killSignalWeight": 5,
        "riskPenalty": 4,
    },
}


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


def validate_gate_id(gate_id: str) -> None:
    if not DATASET_RUN_ID_RE.fullmatch(gate_id) or gate_id in {".", ".."}:
        raise CardValidationError("gate_id may contain only letters, numbers, dot, underscore, and hyphen")


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


def simulation_block(
    *,
    ticks: int = DEFAULT_SIMULATION_TICKS,
    workers: int = DEFAULT_SIMULATION_WORKERS,
    repetitions: int = DEFAULT_SIMULATION_REPETITIONS,
) -> JsonObject:
    return {
        "branch": "$activeWorld",
        "code_path": str(DEFAULT_SIMULATION_CODE_PATH),
        "map_source_file": str(DEFAULT_SIMULATION_MAP_SOURCE_FILE),
        "repetitions": repetitions,
        "room": "E1S1",
        "shard": "shardX",
        "simulator_out_dir": str(DEFAULT_SIMULATION_OUT_DIR),
        "ticks": ticks,
        "workers": workers,
    }


def build_card(
    *,
    dataset_run_id: str,
    code_commit: str,
    training_approach: str,
    created_at: str,
    simulation_ticks: int | None = None,
    simulation_repetitions: int | None = None,
    simulation_workers: int | None = None,
    registry_path: Path | None = None,
    loop_a_card_supply: bool = False,
    source_gate: JsonObject | None = None,
) -> JsonObject:
    validate_dataset_run_id(dataset_run_id)
    validate_code_commit(code_commit)
    validate_created_at(created_at)
    if training_approach not in TRAINING_APPROACHES:
        raise CardValidationError(f"training_approach must be one of: {', '.join(TRAINING_APPROACHES)}")
    if loop_a_card_supply and training_approach != "policy_gradient":
        raise CardValidationError("Loop A card supply requires training_approach=policy_gradient")

    default_ticks = POLICY_GRADIENT_SIMULATION_TICKS if training_approach == "policy_gradient" else DEFAULT_SIMULATION_TICKS
    default_repetitions = (
        POLICY_GRADIENT_SIMULATION_REPETITIONS
        if training_approach == "policy_gradient"
        else DEFAULT_SIMULATION_REPETITIONS
    )
    ticks = require_positive_int(simulation_ticks if simulation_ticks is not None else default_ticks, "simulation.ticks")
    repetitions = require_positive_int(
        simulation_repetitions if simulation_repetitions is not None else default_repetitions,
        "simulation.repetitions",
    )
    workers = require_positive_int(
        simulation_workers if simulation_workers is not None else DEFAULT_SIMULATION_WORKERS,
        "simulation.workers",
    )

    commit_prefix = code_commit[:12].lower()
    card = {
        "card_id": f"rl-exp-{dataset_run_id}-{commit_prefix}",
        "code_commit": code_commit.lower(),
        "conservative_actions_only": True,
        "created_at": created_at,
        "dataset_run_id": dataset_run_id,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "ood_rejection": True,
        "reward_model": reward_model(),
        "safety": safety_block(),
        "simulation": simulation_block(ticks=ticks, workers=workers, repetitions=repetitions),
        "status": "shadow",
        "strategy_variants": list(DEFAULT_STRATEGY_VARIANTS),
        "training_approach": training_approach,
    }
    if training_approach == "policy_gradient":
        policy_gradient = policy_gradient_block(registry_path or DEFAULT_STRATEGY_REGISTRY_PATH)
        card["policy_gradient"] = policy_gradient
        card["strategy_variants"] = policy_gradient_strategy_variants(policy_gradient)
    if loop_a_card_supply:
        card["card_supply"] = loop_a_card_supply_block(
            dataset_run_id=dataset_run_id,
            training_approach=training_approach,
            created_at=created_at,
        )
    if source_gate is not None:
        card["source_gate"] = dict(source_gate)
    validate_card(card)
    return card


def loop_a_card_supply_block(*, dataset_run_id: str, training_approach: str, created_at: str) -> JsonObject:
    return {
        "type": LOOP_A_CARD_SUPPLY_TYPE,
        "consumer": LOOP_A_CARD_SUPPLY_CONSUMER,
        "state": LOOP_A_CARD_SUPPLY_AVAILABLE,
        "available_for_training": True,
        "dataset_run_id": dataset_run_id,
        "training_approach": training_approach,
        "created_at": created_at,
        "status_field": "status",
        "safety_status": "shadow",
        "consumed_at": None,
        "consumed_by_report_id": None,
    }


def source_gate_block(
    *,
    gate_id: str,
    dataset_run_id: str,
    gate_report_path: Path,
    created_at: str | None,
) -> JsonObject:
    validate_gate_id(gate_id)
    validate_dataset_run_id(dataset_run_id)
    if created_at is not None:
        validate_created_at(created_at)
    return {
        "type": "screeps-rl-dataset-evaluation-gate",
        "gate_id": gate_id,
        "dataset_run_id": dataset_run_id,
        "gate_report_path": str(gate_report_path),
        "created_at": created_at,
        "ok": True,
    }


def require_positive_int(value: Any, label: str) -> int:
    parsed = positive_int(value)
    if parsed is None:
        raise CardValidationError(f"{label} must be a positive integer")
    return parsed


def repo_relative(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def policy_gradient_block(registry_path: Path) -> JsonObject:
    candidates = policy_gradient_candidate_vectors(registry_path)
    return {
        "type": "construction-priority-policy-gradient-card",
        "target_family": CONSTRUCTION_PRIORITY_FAMILY,
        "candidate_policy_id_field": "candidatePolicyId",
        "source_registry": repo_relative(registry_path),
        "owning_issues": ["#1032", "#879", "#924"],
        "learnable_parameters": construction_priority_learnable_parameters(registry_path),
        "candidate_parameter_vectors": candidates,
        "runner_support": {
            "inline_candidates_applied_to_simulator": False,
            "simulator_variant_transport": "variant_ids_only",
            "report_preserves_candidate_parameters": True,
            "candidate_policy_id_preserved": True,
            "limitation": (
                "scripts/screeps_rl_training_runner.py currently sends simulator variants by id only; "
                "inline policy-gradient parameter vectors are preserved in card/report artifacts as offline evidence."
            ),
        },
        "safety": safety_block(),
    }


def construction_priority_learnable_parameters(registry_path: Path) -> list[JsonObject]:
    registry_source = repo_relative(registry_path)
    return [
        {
            **dict(knob),
            "source": f"{registry_source} knobBounds",
            "family": CONSTRUCTION_PRIORITY_FAMILY,
        }
        for knob in CONSTRUCTION_PRIORITY_KNOBS
    ]


def policy_gradient_strategy_variants(policy_gradient: JsonObject) -> list[JsonObject]:
    candidates = policy_gradient.get("candidate_parameter_vectors")
    if not isinstance(candidates, list):
        return []
    variants: list[JsonObject] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        strategy_variant_id = candidate.get("strategyVariantId")
        if not isinstance(strategy_variant_id, str):
            continue
        variants.append(
            {
                "id": strategy_variant_id,
                "candidatePolicyId": candidate.get("candidatePolicyId"),
                "sourceStrategyId": candidate.get("sourceStrategyId"),
                "family": candidate.get("family"),
                "rolloutStatus": candidate.get("rolloutStatus"),
                "title": candidate.get("title"),
                "trainingRole": "policy_gradient_candidate",
                "parameters": candidate.get("parameters"),
                "parameterEvidence": candidate.get("parameterEvidence"),
            }
        )
    return variants


def policy_gradient_candidate_vectors(registry_path: Path) -> list[JsonObject]:
    registry_defaults = construction_priority_registry_defaults(registry_path)
    incumbent_id = "construction-priority.incumbent.v1"
    territory_id = "construction-priority.territory-shadow.v1"
    incumbent = registry_defaults[incumbent_id]
    territory = registry_defaults[territory_id]
    candidates = [
        policy_gradient_candidate(
            candidate_policy_id="construction-priority.pg.incumbent-seed.v1",
            source_strategy_id=incumbent_id,
            rollout_status="incumbent",
            title="Policy-gradient incumbent construction-priority seed",
            parameters=incumbent,
            derivation="registry defaultValues seed",
            registry_path=registry_path,
        ),
        policy_gradient_candidate(
            candidate_policy_id="construction-priority.pg.territory-seed.v1",
            source_strategy_id=territory_id,
            rollout_status="shadow",
            title="Policy-gradient territory construction-priority seed",
            parameters=territory,
            derivation="registry defaultValues seed",
            registry_path=registry_path,
        ),
        policy_gradient_candidate(
            candidate_policy_id="construction-priority.pg.resource-seed.v1",
            source_strategy_id=incumbent_id,
            rollout_status="shadow",
            title="Policy-gradient resource construction-priority seed",
            parameters=bounded_construction_priority_parameters(
                {
                    **incumbent,
                    "territorySignalWeight": 10,
                    "resourceSignalWeight": 18,
                    "killSignalWeight": 4,
                    "riskPenalty": 4,
                }
            ),
            derivation="bounded registry-knob perturbation from incumbent defaultValues",
            registry_path=registry_path,
        ),
        policy_gradient_candidate(
            candidate_policy_id="construction-priority.pg.risk-aware-seed.v1",
            source_strategy_id=territory_id,
            rollout_status="shadow",
            title="Policy-gradient risk-aware construction-priority seed",
            parameters=bounded_construction_priority_parameters(
                {
                    **territory,
                    "territorySignalWeight": 18,
                    "resourceSignalWeight": 5,
                    "killSignalWeight": 6,
                    "riskPenalty": 10,
                }
            ),
            derivation="bounded registry-knob perturbation from territory-shadow defaultValues",
            registry_path=registry_path,
        ),
    ]
    return candidates


def policy_gradient_candidate(
    *,
    candidate_policy_id: str,
    source_strategy_id: str,
    rollout_status: str,
    title: str,
    parameters: JsonObject,
    derivation: str,
    registry_path: Path,
) -> JsonObject:
    parameter_vector = bounded_construction_priority_parameters(parameters)
    return {
        "candidatePolicyId": candidate_policy_id,
        "strategyVariantId": candidate_policy_id,
        "sourceStrategyId": source_strategy_id,
        "family": CONSTRUCTION_PRIORITY_FAMILY,
        "rolloutStatus": rollout_status,
        "title": title,
        "parameters": parameter_vector,
        "parameterEvidence": {
            "sourceRegistry": repo_relative(registry_path),
            "sourceStrategyId": source_strategy_id,
            "learnableKnobs": list(CONSTRUCTION_PRIORITY_KNOB_NAMES),
            "derivation": derivation,
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        },
    }


def construction_priority_registry_defaults(registry_path: Path) -> dict[str, JsonObject]:
    defaults = {
        variant_id: dict(parameters)
        for variant_id, parameters in CONSTRUCTION_PRIORITY_FALLBACK_DEFAULTS.items()
    }
    if not registry_path.exists():
        return defaults

    import screeps_rl_training_runner as training_runner

    registry = training_runner.load_strategy_registry(registry_path)
    missing = [variant_id for variant_id in CONSTRUCTION_PRIORITY_REGISTRY_IDS if variant_id not in registry]
    if missing:
        missing_list = ", ".join(missing)
        raise CardValidationError(
            f"strategy registry {repo_relative(registry_path)} is missing construction-priority variants: {missing_list}"
        )
    for variant_id in CONSTRUCTION_PRIORITY_REGISTRY_IDS:
        variant = registry[variant_id]
        parameters = construction_priority_parameters_or_none(variant.parameters)
        if parameters is None:
            raise CardValidationError(
                f"strategy registry {repo_relative(registry_path)} variant {variant_id} "
                "must define finite construction-priority parameters"
            )
        defaults[variant_id] = parameters
    return defaults


def construction_priority_parameters_or_none(raw: Any) -> JsonObject | None:
    if not isinstance(raw, dict):
        return None
    parameters: JsonObject = {}
    for knob in CONSTRUCTION_PRIORITY_KNOB_NAMES:
        value = raw.get(knob)
        if not is_finite_number(value):
            return None
        parameters[knob] = value
    return bounded_construction_priority_parameters(parameters)


def bounded_construction_priority_parameters(raw: JsonObject) -> JsonObject:
    bounded: JsonObject = {}
    for knob in CONSTRUCTION_PRIORITY_KNOBS:
        name = str(knob["name"])
        value = raw.get(name)
        numeric = validate_construction_priority_parameter_value(
            value,
            name,
            f"construction-priority parameter {name}",
        )
        bounded[name] = int(numeric) if numeric.is_integer() else numeric
    return bounded


def validate_construction_priority_parameter_value(value: Any, knob: str, label: str) -> float:
    if not is_finite_number(value):
        raise CardValidationError(f"{label} must be a finite number")
    minimum, maximum = CONSTRUCTION_PRIORITY_PARAMETER_LIMITS[knob]
    numeric = float(value)
    if numeric < minimum or numeric > maximum:
        raise CardValidationError(f"{label} must be within registry knob bounds")
    return numeric


def is_finite_number(value: Any) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(float(value))


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
    validate_card_supply(raw)
    validate_source_gate(raw)
    strategy_variants = first_present(raw, ("strategy_variants", "strategyVariants", "variants"))
    validate_strategy_variants(strategy_variants)
    validate_simulation(first_present(raw, ("simulation", "simulator")))
    policy_gradient = first_present(raw, ("policy_gradient", "policyGradient"))
    if training_approach == "policy_gradient" and policy_gradient is None:
        raise CardValidationError("policy_gradient metadata is required when training_approach is policy_gradient")
    if policy_gradient is not None:
        validate_policy_gradient(policy_gradient)
    if training_approach == "policy_gradient":
        validate_policy_gradient_strategy_variants(policy_gradient, strategy_variants)


def validate_card_supply(card: JsonObject) -> None:
    raw = first_present(card, ("card_supply", "cardSupply"))
    if raw is None:
        return
    if not isinstance(raw, dict):
        raise CardValidationError("card_supply must be a JSON object")
    if raw.get("type") != LOOP_A_CARD_SUPPLY_TYPE:
        raise CardValidationError(f"card_supply.type must be {LOOP_A_CARD_SUPPLY_TYPE}")
    if raw.get("consumer") != LOOP_A_CARD_SUPPLY_CONSUMER:
        raise CardValidationError(f"card_supply.consumer must be {LOOP_A_CARD_SUPPLY_CONSUMER}")
    state = raw.get("state")
    if state not in LOOP_A_CARD_SUPPLY_STATES:
        raise CardValidationError("card_supply.state must be available or consumed")
    if raw.get("dataset_run_id") != card.get("dataset_run_id"):
        raise CardValidationError("card_supply.dataset_run_id must match dataset_run_id")
    if raw.get("training_approach") != card.get("training_approach"):
        raise CardValidationError("card_supply.training_approach must match training_approach")
    if raw.get("safety_status") != "shadow":
        raise CardValidationError("card_supply.safety_status must be shadow")
    if raw.get("status_field") != "status":
        raise CardValidationError("card_supply.status_field must be status")
    created_at = raw.get("created_at")
    if not isinstance(created_at, str):
        raise CardValidationError("card_supply.created_at must be an ISO UTC timestamp")
    validate_created_at(created_at)

    if state == LOOP_A_CARD_SUPPLY_AVAILABLE:
        if card.get("status") != "shadow":
            raise CardValidationError("available Loop A card supply requires status=shadow")
        if card.get("training_approach") != "policy_gradient":
            raise CardValidationError("available Loop A card supply requires training_approach=policy_gradient")
        if raw.get("available_for_training") is not True:
            raise CardValidationError("card_supply.available_for_training must be true for available supply")
        if raw.get("consumed_at") is not None:
            raise CardValidationError("available Loop A card supply must not set consumed_at")
        if raw.get("consumed_by_report_id") is not None:
            raise CardValidationError("available Loop A card supply must not set consumed_by_report_id")
    else:
        if raw.get("available_for_training") is not False:
            raise CardValidationError("consumed Loop A card supply must set available_for_training=false")
        consumed_at = raw.get("consumed_at")
        if not isinstance(consumed_at, str):
            raise CardValidationError("consumed Loop A card supply requires consumed_at")
        validate_created_at(consumed_at)
        if not isinstance(raw.get("consumed_by_report_id"), str) or not raw.get("consumed_by_report_id"):
            raise CardValidationError("consumed Loop A card supply requires consumed_by_report_id")


def validate_source_gate(card: JsonObject) -> None:
    raw = first_present(card, ("source_gate", "sourceGate"))
    if raw is None:
        return
    if not isinstance(raw, dict):
        raise CardValidationError("source_gate must be a JSON object")
    if raw.get("type") not in (None, "screeps-rl-dataset-evaluation-gate"):
        raise CardValidationError("source_gate.type must be screeps-rl-dataset-evaluation-gate")
    gate_id = first_present(raw, ("gate_id", "gateId"))
    if not isinstance(gate_id, str) or not gate_id:
        raise CardValidationError("source_gate.gate_id must be a non-empty string")
    validate_gate_id(gate_id)
    dataset_run_id = first_present(raw, ("dataset_run_id", "datasetRunId"))
    if dataset_run_id != card.get("dataset_run_id"):
        raise CardValidationError("source_gate.dataset_run_id must match dataset_run_id")
    gate_report_path = first_present(raw, ("gate_report_path", "gateReportPath"))
    if not isinstance(gate_report_path, str) or not gate_report_path:
        raise CardValidationError("source_gate.gate_report_path must be a non-empty string")
    if raw.get("ok") is not True:
        raise CardValidationError("source_gate.ok must be true")
    created_at = first_present(raw, ("created_at", "createdAt"))
    if created_at is not None:
        if not isinstance(created_at, str):
            raise CardValidationError("source_gate.created_at must be an ISO UTC timestamp")
        validate_created_at(created_at)


def is_loop_a_card_available_for_training(card: JsonObject, consumed_card_ids: set[str] | None = None) -> bool:
    try:
        validate_card(card)
    except CardValidationError:
        return False
    supply = first_present(card, ("card_supply", "cardSupply"))
    if not isinstance(supply, dict):
        return False
    card_id = card.get("card_id")
    if consumed_card_ids is not None and isinstance(card_id, str) and card_id in consumed_card_ids:
        return False
    return (
        card.get("status") == "shadow"
        and card.get("training_approach") == "policy_gradient"
        and supply.get("state") == LOOP_A_CARD_SUPPLY_AVAILABLE
        and supply.get("available_for_training") is True
        and supply.get("consumer") == LOOP_A_CARD_SUPPLY_CONSUMER
    )


def consumed_card_ids_from_training_reports(report_root: Path) -> set[str]:
    consumed: set[str] = set()
    if not report_root.exists():
        return consumed
    for path in sorted(report_root.rglob("*.json")):
        try:
            payload = load_json(path)
        except CardValidationError:
            continue
        if not isinstance(payload, dict) or payload.get("type") != "screeps-rl-training-report":
            continue
        card = payload.get("experimentCard")
        if not isinstance(card, dict):
            continue
        card_supply = first_present(card, ("cardSupply", "card_supply"))
        if not is_loop_a_card_supply_metadata(card_supply):
            continue
        card_id = card.get("cardId", card.get("card_id"))
        if isinstance(card_id, str) and card_id:
            consumed.add(card_id)
    return consumed


def is_loop_a_card_supply_metadata(raw: Any) -> bool:
    return (
        isinstance(raw, dict)
        and raw.get("type") == LOOP_A_CARD_SUPPLY_TYPE
        and raw.get("consumer") == LOOP_A_CARD_SUPPLY_CONSUMER
    )


def select_loop_a_card_supply(card_dir: Path, training_report_root: Path) -> JsonObject | None:
    consumed_card_ids = consumed_card_ids_from_training_reports(training_report_root)
    candidates: list[tuple[str, str, Path, JsonObject]] = []
    if not card_dir.exists():
        return None
    for path in sorted(card_dir.rglob("*.json")):
        try:
            card = load_json(path)
        except CardValidationError:
            continue
        if not isinstance(card, dict):
            continue
        if not is_loop_a_card_available_for_training(card, consumed_card_ids):
            continue
        created_at = str(card.get("created_at") or "")
        card_id = str(card.get("card_id") or "")
        candidates.append((created_at, card_id, path, card))
    if not candidates:
        return None
    candidates.sort(key=lambda item: (item[0], item[1], str(item[2])), reverse=True)
    _, _, path, card = candidates[0]
    return loop_a_selection_summary(path, card, consumed_card_ids)


def loop_a_selection_summary(path: Path, card: JsonObject, consumed_card_ids: set[str]) -> JsonObject:
    return {
        "ok": True,
        "card_path": str(path),
        "card_id": card.get("card_id"),
        "dataset_run_id": card.get("dataset_run_id"),
        "training_approach": card.get("training_approach"),
        "status": card.get("status"),
        "card_supply": first_present(card, ("card_supply", "cardSupply")),
        "consumed_card_count": len(consumed_card_ids),
    }


def select_accepted_dataset_gate(gate_root: Path, gate_id: str | None = None) -> JsonObject:
    if gate_id is not None:
        validate_gate_id(gate_id)
    candidates: list[tuple[str, float, str, str, Path]] = []
    if not gate_root.exists():
        raise CardValidationError(f"dataset gate root does not exist: {gate_root}")
    for path in sorted(gate_root.rglob("*.json")):
        try:
            payload = load_json(path)
        except CardValidationError:
            continue
        if not isinstance(payload, dict) or payload.get("ok") is not True:
            continue
        try:
            selected_gate_id = accepted_dataset_gate_id(payload, path)
            if gate_id is not None and selected_gate_id != gate_id:
                continue
            run_id = accepted_dataset_run_id(payload)
            if run_id is None:
                continue
            created_at = accepted_dataset_created_at(payload)
            mtime = path.stat().st_mtime
        except (CardValidationError, OSError):
            continue
        candidates.append((created_at or "", mtime, selected_gate_id, run_id, path))
    if not candidates:
        if gate_id is not None:
            raise CardValidationError(f"no accepted dataset gate {gate_id} with datasetRunId found under {gate_root}")
        raise CardValidationError(f"no accepted dataset gate with datasetRunId found under {gate_root}")
    candidates.sort(key=lambda item: (item[0], item[1], item[2], str(item[4])), reverse=True)
    created_at, _, selected_gate_id, run_id, path = candidates[0]
    return source_gate_block(
        gate_id=selected_gate_id,
        dataset_run_id=run_id,
        gate_report_path=path,
        created_at=created_at or None,
    )


def latest_accepted_dataset_run_id(gate_root: Path) -> str:
    return str(select_accepted_dataset_gate(gate_root)["dataset_run_id"])


def accepted_dataset_gate_id(payload: JsonObject, path: Path) -> str:
    for key in ("gateId", "gate_id"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            validate_gate_id(value)
            return value
    value = path.parent.name
    validate_gate_id(value)
    return value


def accepted_dataset_run_id(payload: JsonObject) -> str | None:
    direct = payload.get("datasetRunId")
    if isinstance(direct, str) and direct:
        validate_dataset_run_id(direct)
        return direct
    dataset = payload.get("dataset")
    if isinstance(dataset, dict):
        run_id = dataset.get("runId")
        if isinstance(run_id, str) and run_id:
            validate_dataset_run_id(run_id)
            return run_id
    return None


def accepted_dataset_created_at(payload: JsonObject) -> str | None:
    for key in ("createdAt", "generatedAt"):
        value = payload.get(key)
        if isinstance(value, str) and ISO_TIMESTAMP_RE.fullmatch(value):
            return value
    return None


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
        if field in raw and raw[field] is not True:
            raise CardValidationError(f"{field} must be true when present")


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


def validate_strategy_variants(raw: Any) -> None:
    if not isinstance(raw, list) or len(raw) == 0:
        raise CardValidationError("strategy_variants must contain at least one registry id or inline variant")
    for index, item in enumerate(raw):
        if isinstance(item, str):
            validate_strategy_id(item, f"strategy_variants[{index}]")
            continue
        if not isinstance(item, dict):
            raise CardValidationError(f"strategy_variants[{index}] must be a string or JSON object")
        variant_id = item.get("id")
        if not isinstance(variant_id, str) or not variant_id:
            raise CardValidationError(f"strategy_variants[{index}].id must be a non-empty string")
        validate_strategy_id(variant_id, f"strategy_variants[{index}].id")


def validate_strategy_id(value: str, label: str) -> None:
    if not STRATEGY_ID_RE.fullmatch(value) or value in {".", ".."}:
        raise CardValidationError(f"{label} may contain only letters, numbers, dot, colon, underscore, and hyphen")


def validate_policy_gradient(raw: Any) -> None:
    if not isinstance(raw, dict):
        raise CardValidationError("policy_gradient must be a JSON object")
    if raw.get("target_family", raw.get("targetFamily")) != CONSTRUCTION_PRIORITY_FAMILY:
        raise CardValidationError("policy_gradient.target_family must be construction-priority")
    learnable = first_present(raw, ("learnable_parameters", "learnableParameters"))
    if not isinstance(learnable, list):
        raise CardValidationError("policy_gradient.learnable_parameters must be a list")
    learnable_names = []
    for index, item in enumerate(learnable):
        if not isinstance(item, dict):
            raise CardValidationError(f"policy_gradient.learnable_parameters[{index}] must be an object")
        name = item.get("name")
        if not isinstance(name, str):
            raise CardValidationError(f"policy_gradient.learnable_parameters[{index}].name must be a string")
        learnable_names.append(name)
    if learnable_names != list(CONSTRUCTION_PRIORITY_KNOB_NAMES):
        raise CardValidationError("policy_gradient.learnable_parameters must match construction-priority registry knobs")

    candidates = first_present(raw, ("candidate_parameter_vectors", "candidateParameterVectors"))
    if not isinstance(candidates, list) or len(candidates) == 0:
        raise CardValidationError("policy_gradient.candidate_parameter_vectors must contain at least one vector")
    candidate_ids: set[str] = set()
    for index, candidate in enumerate(candidates):
        validate_policy_gradient_candidate(candidate, index)
        assert isinstance(candidate, dict)
        candidate_policy_id = candidate["candidatePolicyId"]
        if candidate_policy_id in candidate_ids:
            raise CardValidationError(f"duplicate policy_gradient candidatePolicyId: {candidate_policy_id}")
        candidate_ids.add(candidate_policy_id)

    support = first_present(raw, ("runner_support", "runnerSupport"))
    if not isinstance(support, dict):
        raise CardValidationError("policy_gradient.runner_support must be a JSON object")
    inline_applied = first_present(support, ("inline_candidates_applied_to_simulator", "inlineCandidatesAppliedToSimulator"))
    if inline_applied is not False:
        raise CardValidationError("policy_gradient.runner_support.inline_candidates_applied_to_simulator must be false")
    transport = first_present(support, ("simulator_variant_transport", "simulatorVariantTransport"))
    if transport != "variant_ids_only":
        raise CardValidationError("policy_gradient.runner_support.simulator_variant_transport must be variant_ids_only")
    preserves_parameters = first_present(
        support,
        ("report_preserves_candidate_parameters", "reportPreservesCandidateParameters"),
    )
    if preserves_parameters is not True:
        raise CardValidationError("policy_gradient.runner_support.report_preserves_candidate_parameters must be true")
    preserves_candidate_policy_id = first_present(
        support,
        ("candidate_policy_id_preserved", "candidatePolicyIdPreserved"),
    )
    if preserves_candidate_policy_id is not True:
        raise CardValidationError("policy_gradient.runner_support.candidate_policy_id_preserved must be true")

    safety = raw.get("safety")
    if safety is not None:
        validate_safety({"safety": safety})


def validate_policy_gradient_strategy_variants(policy_gradient: Any, strategy_variants: Any) -> None:
    if not isinstance(policy_gradient, dict):
        return
    candidates = first_present(policy_gradient, ("candidate_parameter_vectors", "candidateParameterVectors"))
    if not isinstance(candidates, list) or not isinstance(strategy_variants, list):
        return
    if len(strategy_variants) != len(candidates):
        raise CardValidationError(
            "strategy_variants must mirror policy_gradient.candidate_parameter_vectors for policy_gradient cards"
        )

    seen_strategy_variant_ids: set[str] = set()
    for index, candidate in enumerate(candidates):
        if not isinstance(candidate, dict):
            continue
        strategy_variant = strategy_variants[index]
        if not isinstance(strategy_variant, dict):
            raise CardValidationError(
                f"strategy_variants[{index}] must be an inline policy-gradient candidate variant"
            )
        expected_variant_id = candidate.get("strategyVariantId")
        expected_candidate_policy_id = candidate.get("candidatePolicyId")
        variant_id = strategy_variant.get("id")
        if variant_id != expected_variant_id:
            raise CardValidationError(
                f"strategy_variants[{index}].id must match "
                f"policy_gradient.candidate_parameter_vectors[{index}].strategyVariantId"
            )
        if variant_id in seen_strategy_variant_ids:
            raise CardValidationError(f"duplicate policy_gradient strategyVariantId: {variant_id}")
        seen_strategy_variant_ids.add(variant_id)

        candidate_policy_id = first_present(strategy_variant, ("candidatePolicyId", "candidate_policy_id"))
        if candidate_policy_id != expected_candidate_policy_id:
            raise CardValidationError(
                f"strategy_variants[{index}].candidatePolicyId must match "
                f"policy_gradient.candidate_parameter_vectors[{index}].candidatePolicyId"
            )
        parameters = first_present(strategy_variant, ("parameters", "params", "defaultValues", "default_values"))
        if parameters != candidate.get("parameters"):
            raise CardValidationError(
                f"strategy_variants[{index}].parameters must match "
                f"policy_gradient.candidate_parameter_vectors[{index}].parameters"
            )


def validate_policy_gradient_candidate(raw: Any, index: int) -> None:
    if not isinstance(raw, dict):
        raise CardValidationError(f"policy_gradient.candidate_parameter_vectors[{index}] must be an object")
    for field in ("candidatePolicyId", "strategyVariantId", "sourceStrategyId", "family", "rolloutStatus"):
        value = raw.get(field)
        if not isinstance(value, str) or not value:
            raise CardValidationError(f"policy_gradient.candidate_parameter_vectors[{index}].{field} must be a string")
    validate_strategy_id(raw["candidatePolicyId"], f"policy_gradient.candidate_parameter_vectors[{index}].candidatePolicyId")
    validate_strategy_id(raw["strategyVariantId"], f"policy_gradient.candidate_parameter_vectors[{index}].strategyVariantId")
    validate_strategy_id(raw["sourceStrategyId"], f"policy_gradient.candidate_parameter_vectors[{index}].sourceStrategyId")
    if raw["family"] != CONSTRUCTION_PRIORITY_FAMILY:
        raise CardValidationError(f"policy_gradient.candidate_parameter_vectors[{index}].family must be construction-priority")
    parameters = raw.get("parameters")
    if not isinstance(parameters, dict):
        raise CardValidationError(f"policy_gradient.candidate_parameter_vectors[{index}].parameters must be an object")
    for knob in CONSTRUCTION_PRIORITY_KNOB_NAMES:
        if knob not in parameters:
            raise CardValidationError(
                f"policy_gradient.candidate_parameter_vectors[{index}].parameters.{knob} is required"
            )
        validate_construction_priority_parameter_value(
            parameters[knob],
            knob,
            f"policy_gradient.candidate_parameter_vectors[{index}].parameters.{knob}",
        )


def first_present(raw: JsonObject, keys: tuple[str, ...]) -> Any:
    for key in keys:
        if key in raw:
            return raw[key]
    return None


def validate_simulation(raw: Any) -> None:
    if not isinstance(raw, dict):
        raise CardValidationError("simulation must be a JSON object")
    for field in ("ticks", "workers", "repetitions"):
        if positive_int(raw.get(field)) is None:
            raise CardValidationError(f"simulation.{field} must be a positive integer")
    host_port_start = first_present(raw, ("host_port_start", "hostPortStart"))
    if host_port_start is not None and positive_int(host_port_start) is None:
        raise CardValidationError("simulation.host_port_start must be a positive integer")
    for field, aliases in (
        ("room", ("room",)),
        ("shard", ("shard",)),
        ("branch", ("branch",)),
        ("code_path", ("code_path", "codePath")),
        ("map_source_file", ("map_source_file", "mapSourceFile")),
        ("simulator_out_dir", ("simulator_out_dir", "simulatorOutDir")),
    ):
        value = first_present(raw, aliases)
        if not isinstance(value, str) or not value:
            raise CardValidationError(f"simulation.{field} must be a non-empty string")


def positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value > 0:
        return value
    if isinstance(value, float) and math.isfinite(value) and value.is_integer() and value > 0:
        return int(value)
    return None


def write_output(payload: Any, output: Path | None, stdout: TextIO) -> None:
    text = canonical_json(payload)
    if output is None:
        stdout.write(text)
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(text, encoding="utf-8")


def validation_summary(card: JsonObject) -> JsonObject:
    safety = card.get("safety") if isinstance(card.get("safety"), dict) else {}
    summary = {
        "card_id": card.get("card_id"),
        "dataset_run_id": card.get("dataset_run_id"),
        "ok": True,
        "safety": {
            field: safety.get(field)
            for field in (*SAFETY_FALSE_FIELDS, *SAFETY_TRUE_FIELDS)
        },
        "status": card.get("status"),
    }
    card_supply = first_present(card, ("card_supply", "cardSupply"))
    if isinstance(card_supply, dict):
        summary["card_supply"] = card_supply
        summary["loop_a_available_for_training"] = is_loop_a_card_available_for_training(card)
    source_gate = first_present(card, ("source_gate", "sourceGate"))
    if isinstance(source_gate, dict):
        summary["source_gate"] = source_gate
    return summary


def generated_card_summary(
    card: JsonObject,
    output_path: Path,
    *,
    loop_a_local_fallback: bool = False,
) -> JsonObject:
    summary = validation_summary(card)
    summary["path"] = str(output_path)
    summary["created_at"] = card.get("created_at")
    summary["training_approach"] = card.get("training_approach")
    summary["loop_a_local_fallback"] = loop_a_local_fallback
    return summary


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


def positive_int_arg(raw: str) -> int:
    try:
        value = int(raw)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive integer") from error
    if value <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return value


def loop_a_local_fallback_value(value: int | None, *, default: int, maximum: int, label: str) -> int:
    resolved = default if value is None else value
    if resolved > maximum:
        raise CardValidationError(f"Loop A local fallback {label} must be <= {maximum}")
    return resolved


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
        "--ticks",
        type=positive_int_arg,
        help=(
            "Simulation ticks to request. Defaults to 50, or 100 for policy_gradient cards."
        ),
    )
    parser.add_argument(
        "--repetitions",
        type=positive_int_arg,
        help=(
            "Simulation repetitions to request. Defaults to 1, or 5 for policy_gradient cards."
        ),
    )
    parser.add_argument(
        "--workers",
        type=positive_int_arg,
        help="Simulator worker count to request. Defaults to 1.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Generate a synthetic offline card without requiring a real dataset run artifact.",
    )
    parser.add_argument(
        "--loop-a-policy-gradient-supply",
        action="store_true",
        help=(
            "Generate an offline/shadow policy_gradient card with explicit Loop A "
            "available-for-training supply metadata."
        ),
    )
    parser.add_argument(
        "--loop-a-local-fallback",
        action="store_true",
        help=(
            "Write a standalone Loop A local-fallback experiment_card.json from an accepted "
            "dataset gate. Implies policy_gradient card supply and defaults to 5 workers, "
            "5 repetitions, and 200 ticks."
        ),
    )
    parser.add_argument(
        "--from-latest-accepted-dataset",
        action="store_true",
        help="Use the latest accepted dataset gate under --dataset-gate-root as dataset_run_id.",
    )
    parser.add_argument(
        "--source-gate-id",
        help="Accepted dataset gate ID to use as source provenance for the generated card.",
    )
    parser.add_argument(
        "--dataset-gate-root",
        type=Path,
        default=DEFAULT_DATASET_GATE_ROOT,
        help=f"Root scanned by --from-latest-accepted-dataset. Default: {DEFAULT_DATASET_GATE_ROOT}.",
    )
    parser.add_argument(
        "--select-loop-a-card",
        action="store_true",
        help="Select the newest Loop A card_supply.available card not already referenced by a training report.",
    )
    parser.add_argument(
        "--card-dir",
        type=Path,
        default=DEFAULT_EXPERIMENT_CARD_DIR,
        help=f"Experiment card directory scanned by --select-loop-a-card. Default: {DEFAULT_EXPERIMENT_CARD_DIR}.",
    )
    parser.add_argument(
        "--training-report-dir",
        type=Path,
        default=DEFAULT_TRAINING_REPORT_ROOT,
        help=f"Training report directory scanned by --select-loop-a-card. Default: {DEFAULT_TRAINING_REPORT_ROOT}.",
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
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="Write generated card to <output-dir>/<card_id>.json and print a compact summary.",
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

        if args.output is not None and args.output_dir is not None:
            raise CardValidationError("--output and --output-dir are mutually exclusive")
        if args.loop_a_local_fallback and args.output_dir is not None:
            raise CardValidationError("--loop-a-local-fallback writes a standalone experiment_card.json; use --output")
        if args.loop_a_local_fallback and args.dry_run:
            raise CardValidationError("--loop-a-local-fallback requires an accepted dataset gate")

        if args.select_loop_a_card:
            if args.validate or args.loop_a_local_fallback:
                raise CardValidationError("--select-loop-a-card cannot be combined with --validate or --loop-a-local-fallback")
            selected = select_loop_a_card_supply(args.card_dir, args.training_report_dir)
            if selected is None:
                write_output(
                    {
                        "ok": False,
                        "reason": "NO_AVAILABLE_LOOP_A_CARD",
                        "card_dir": str(args.card_dir),
                        "training_report_dir": str(args.training_report_dir),
                    },
                    args.output,
                    stdout,
                )
                return 1
            write_output(selected, args.output, stdout)
            return 0

        if args.validate:
            if args.input is None:
                raise CardValidationError("--validate requires --input")
            loaded = load_json(args.input)
            validate_card(loaded)
            write_output(validation_summary(loaded), args.output, stdout)
            return 0

        dataset_run_id = args.dataset_run_id
        source_gate = None
        if args.from_latest_accepted_dataset and dataset_run_id is not None:
            raise CardValidationError("--from-latest-accepted-dataset cannot be combined with --dataset-run-id")
        if args.source_gate_id is not None:
            source_gate = select_accepted_dataset_gate(args.dataset_gate_root, args.source_gate_id)
            source_dataset_run_id = str(source_gate["dataset_run_id"])
            if dataset_run_id is not None and dataset_run_id != source_dataset_run_id:
                raise CardValidationError("--dataset-run-id must match --source-gate-id dataset_run_id")
            dataset_run_id = source_dataset_run_id
        elif args.from_latest_accepted_dataset or args.loop_a_local_fallback:
            if dataset_run_id is not None:
                raise CardValidationError("--from-latest-accepted-dataset cannot be combined with --dataset-run-id")
            source_gate = select_accepted_dataset_gate(args.dataset_gate_root)
            dataset_run_id = str(source_gate["dataset_run_id"])
        if dataset_run_id is None:
            if not args.dry_run:
                raise CardValidationError("--dataset-run-id is required unless --dry-run is used")
            dataset_run_id = DRY_RUN_DATASET_RUN_ID

        loop_a_card_supply = args.loop_a_policy_gradient_supply or args.loop_a_local_fallback
        training_approach = "policy_gradient" if loop_a_card_supply else args.training_approach
        simulation_ticks = args.ticks
        simulation_repetitions = args.repetitions
        simulation_workers = args.workers
        if args.loop_a_local_fallback:
            simulation_ticks = loop_a_local_fallback_value(
                args.ticks,
                default=LOOP_A_LOCAL_FALLBACK_TICKS,
                maximum=LOOP_A_LOCAL_FALLBACK_TICKS,
                label="ticks",
            )
            simulation_repetitions = loop_a_local_fallback_value(
                args.repetitions,
                default=LOOP_A_LOCAL_FALLBACK_REPETITIONS,
                maximum=LOOP_A_LOCAL_FALLBACK_REPETITIONS,
                label="repetitions",
            )
            simulation_workers = loop_a_local_fallback_value(
                args.workers,
                default=LOOP_A_LOCAL_FALLBACK_WORKERS,
                maximum=LOOP_A_LOCAL_FALLBACK_WORKERS,
                label="workers",
            )
        card = build_card(
            dataset_run_id=dataset_run_id,
            code_commit=args.code_commit or git_commit(repo),
            training_approach=training_approach,
            created_at=args.created_at or utc_now_iso(),
            simulation_ticks=simulation_ticks,
            simulation_repetitions=simulation_repetitions,
            simulation_workers=simulation_workers,
            loop_a_card_supply=loop_a_card_supply,
            source_gate=source_gate,
        )
        if args.loop_a_local_fallback:
            output_path = args.output or repo / DEFAULT_LOOP_A_LOCAL_FALLBACK_CARD_PATH.relative_to(REPO_ROOT)
            write_output(card, output_path, stdout)
            stdout.write(canonical_json(generated_card_summary(card, output_path, loop_a_local_fallback=True)))
            return 0
        if args.output_dir is not None:
            output_path = args.output_dir / f"{card['card_id']}.json"
            write_output(card, output_path, stdout)
            stdout.write(canonical_json(generated_card_summary(card, output_path)))
            return 0
        write_output(card, args.output, stdout)
        return 0
    except CardValidationError as error:
        stderr.write(f"error: {error}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main(repo_root=Path(__file__).resolve().parent.parent))
