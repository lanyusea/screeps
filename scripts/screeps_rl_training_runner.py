#!/usr/bin/env python3
"""Run offline Screeps RL strategy experiments against the private simulator harness."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import re
import statistics
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Sequence, TextIO

from screeps_rl_experiment_card import (
    scenario_supports_multi_tier_policy_comparison,
    validate_scenario_metadata,
)
import screeps_rl_dataset_export as dataset_export
import screeps_secret_env
import screeps_rl_simulator_harness as simulator_harness


SCHEMA_VERSION = 1
REPORT_TYPE = "screeps-rl-training-report"
SUMMARY_TYPE = "screeps-rl-training-generation"
DEFAULT_OUT_DIR = Path("runtime-artifacts/rl-training")
DEFAULT_RESOURCE_NORMALIZER = 1000.0
DEFAULT_RUN_REPETITIONS = 1
DEFAULT_STEAM_KEY_ENV_FILE = screeps_secret_env.DEFAULT_LOCAL_SECRET_ENV_FILE
STEAM_KEY_ENV_FILE_ENV = "SCREEPS_RL_STEAM_KEY_ENV_FILE"
DEFAULT_POLICY_UPDATE_LEARNING_RATE = 0.25
RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM = "rank_weighted_finite_difference_v1"
TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM = "reinforce_v1"
POLICY_UPDATE_ALGORITHM = RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM
DEFAULT_POLICY_UPDATE_ALGORITHM = TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM
POLICY_UPDATE_ARTIFACT_DIR = "policy-candidates"
REWARD_TIERS = ("reliability", "territory", "resources", "kills")
MULTI_TIER_ACTIVATION_PROOF_TYPE = "screeps-rl-multi-tier-activation-proof"
MULTI_TIER_TERRITORY_ACTIVATION_THRESHOLD = 2
MULTI_TIER_HOSTILE_KILLS_ACTIVATION_THRESHOLD = 0
SAFETY_FALSE_FIELDS = ("liveEffect", "officialMmoWrites", "officialMmoWritesAllowed")
SAFETY_TRUE_FIELDS = ("conservative_actions_only", "ood_rejection")
LOOP_A_CARD_SUPPLY_TYPE = "screeps-rl-loop-a-card-supply"
LOOP_A_CARD_SUPPLY_CONSUMER = "loop-a-policy-gradient"
LOOP_A_CARD_SUPPLY_AVAILABLE = "available"
LOOP_A_CARD_SUPPLY_CONSUMED = "consumed"
LOOP_A_CARD_SUPPLY_STATES = (LOOP_A_CARD_SUPPLY_AVAILABLE, LOOP_A_CARD_SUPPLY_CONSUMED)
REPORT_ID_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
STRATEGY_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]+$")
ISO_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
JsonObject = dict[str, Any]
SimulatorRunner = Callable[..., JsonObject]


class TrainingCardError(ValueError):
    """Raised when an experiment card is unsafe or structurally invalid."""


@dataclass(frozen=True)
class StrategyVariant:
    """Strategy candidate metadata consumed by the simulator and report."""

    id: str
    parameters: JsonObject
    candidate_policy_id: str | None = None
    family: str | None = None
    parameter_evidence: JsonObject | None = None
    rollout_status: str | None = None
    source_strategy_id: str | None = None
    source: str = "inline"
    title: str | None = None
    training_role: str | None = None

    def to_json(self) -> JsonObject:
        payload: JsonObject = {
            "id": self.id,
            "parameters": self.parameters,
            "source": self.source,
        }
        if self.candidate_policy_id:
            payload["candidatePolicyId"] = self.candidate_policy_id
        if self.family:
            payload["family"] = self.family
        if self.parameter_evidence is not None:
            payload["parameterEvidence"] = copy.deepcopy(self.parameter_evidence)
        if self.rollout_status:
            payload["rolloutStatus"] = self.rollout_status
        if self.source_strategy_id:
            payload["sourceStrategyId"] = self.source_strategy_id
        if self.title:
            payload["title"] = self.title
        if self.training_role:
            payload["trainingRole"] = self.training_role
        return payload


@dataclass(frozen=True)
class SimulationConfig:
    """Private simulator run settings shared across all variants."""

    ticks: int
    workers: int
    repetitions: int
    host_port_start: int
    room: str
    shard: str
    branch: str
    code_path: Path
    map_source_file: Path
    simulator_out_dir: Path
    scale_environments: int | None = None
    min_concurrent_environments: int | None = None

    def to_json(self) -> JsonObject:
        payload: JsonObject = {
            "ticks": self.ticks,
            "workers": self.workers,
            "repetitions": self.repetitions,
            "hostPortStart": self.host_port_start,
            "room": self.room,
            "shard": self.shard,
            "branch": self.branch,
            "codePath": str(self.code_path),
            "mapSourceFile": str(self.map_source_file),
            "simulatorOutDir": str(self.simulator_out_dir),
        }
        if self.scale_environments is not None:
            payload["scaleEnvironments"] = self.scale_environments
        if self.min_concurrent_environments is not None:
            payload["minConcurrentEnvironments"] = self.min_concurrent_environments
        return payload


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    ).hexdigest()


def ensure_steam_key_for_training(
    *,
    simulator_runner: SimulatorRunner,
    env_file: Path | None = None,
) -> None:
    """Load STEAM_KEY for real simulator-backed training runs when the shell omitted it."""
    if os.environ.get("STEAM_KEY", "").strip():
        return
    if (
        env_file is None
        and not os.environ.get(STEAM_KEY_ENV_FILE_ENV)
        and simulator_runner is not simulator_harness.run_simulator
    ):
        return
    screeps_secret_env.ensure_env_value_from_file(
        "STEAM_KEY",
        env_file=env_file,
        override_env_var=STEAM_KEY_ENV_FILE_ENV,
        default_env_file=DEFAULT_STEAM_KEY_ENV_FILE,
    )


def read_steam_key_from_env_file(path: Path) -> str | None:
    try:
        return screeps_secret_env.read_env_value_from_file(path, "STEAM_KEY")
    except RuntimeError as error:
        display_path = dataset_export.display_path(path)
        message = str(error).replace(str(path), display_path)
        raise RuntimeError(message) from error


def parse_steam_key_env_line(line: str) -> str | None:
    parsed = screeps_secret_env.parse_env_assignment_line(line)
    if parsed is None:
        return None
    key, value = parsed
    return value if key == "STEAM_KEY" else None


def parse_env_assignment_value(raw: str) -> str:
    return screeps_secret_env.parse_env_assignment_value(raw)


def strip_unquoted_env_comment(raw: str) -> str:
    return screeps_secret_env.strip_unquoted_env_comment(raw)


def load_experiment_card(path: Path) -> JsonObject:
    """Load a JSON or YAML experiment card from disk."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise TrainingCardError(f"could not read experiment card {path}: {error}") from error

    parsed: Any
    if path.suffix.lower() == ".json":
        parsed = parse_json_card(text, path)
    else:
        stripped = text.lstrip()
        if stripped.startswith("{") or stripped.startswith("["):
            parsed = parse_json_card(text, path)
        else:
            parsed = parse_yaml_card(text, path)

    if not isinstance(parsed, dict):
        raise TrainingCardError("experiment card must be a JSON/YAML object")
    validate_experiment_card(parsed)
    return parsed


def parse_json_card(text: str, path: Path) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError as error:
        raise TrainingCardError(f"{path} is not valid JSON: {error}") from error


def parse_yaml_card(text: str, path: Path) -> Any:
    try:
        import yaml  # type: ignore[import-not-found]
    except ModuleNotFoundError as error:
        raise TrainingCardError(f"{path} is YAML, but PyYAML is not installed") from error
    try:
        return yaml.safe_load(text)
    except Exception as error:  # noqa: BLE001 - PyYAML exposes several parse exception classes
        raise TrainingCardError(f"{path} is not valid YAML: {error}") from error


def validate_experiment_card(card: JsonObject) -> None:
    if card.get("status") != "shadow":
        raise TrainingCardError("status must be shadow")

    safety = card.get("safety")
    if not isinstance(safety, dict):
        raise TrainingCardError("safety must be present and must be an object")
    for field in SAFETY_FALSE_FIELDS:
        if safety.get(field) is not False:
            raise TrainingCardError(f"safety.{field} must be false")
        if field in card and card[field] is not False:
            raise TrainingCardError(f"{field} must be false when present")
    for field in SAFETY_TRUE_FIELDS:
        if safety.get(field) is not True:
            raise TrainingCardError(f"safety.{field} must be true")
        if field in card and card[field] is not True:
            raise TrainingCardError(f"{field} must be true when present")

    reward_model = card.get("reward_model", card.get("rewardModel"))
    if not isinstance(reward_model, dict):
        raise TrainingCardError("reward_model must be present and must be an object")
    if reward_model.get("type") != "lexicographic":
        raise TrainingCardError("reward_model.type must be lexicographic")
    order = reward_model.get("component_order", reward_model.get("componentOrder"))
    if order != list(REWARD_TIERS):
        raise TrainingCardError("reward_model.component_order must preserve reliability, territory, resources, kills")
    scalar_authorized = reward_model.get(
        "scalar_weighted_sum_authorized",
        reward_model.get("scalarWeightedSumAuthorized"),
    )
    if scalar_authorized is not False:
        raise TrainingCardError("reward_model.scalar_weighted_sum_authorized must be false")

    validate_card_supply(card)
    validate_scenario_metadata(card, error_cls=TrainingCardError, require_presence=True)

    raw_variants = raw_variant_definitions(card)
    if not isinstance(raw_variants, list) or len(raw_variants) == 0:
        raise TrainingCardError("experiment card must define at least one strategy variant")

    simulation = raw_mapping(card.get("simulation", card.get("simulator", {})), "simulation")
    if "ticks" in simulation and positive_int_value(simulation["ticks"]) is None:
        raise TrainingCardError("simulation.ticks must be a positive integer")
    if "workers" in simulation and positive_int_value(simulation["workers"]) is None:
        raise TrainingCardError("simulation.workers must be a positive integer")
    for field, aliases in (
        ("scale_environments", ("scale_environments", "scaleEnvironments")),
        ("min_concurrent_environments", ("min_concurrent_environments", "minConcurrentEnvironments")),
    ):
        value = first_present(simulation, aliases)
        if value is not None and positive_int_value(value) is None:
            raise TrainingCardError(f"simulation.{field} must be a positive integer")
    if "repetitions" in simulation and positive_int_value(simulation["repetitions"]) is None:
        raise TrainingCardError("simulation.repetitions must be a positive integer")
    if (
        ("host_port_start" in simulation or "hostPortStart" in simulation)
        and positive_int_value(simulation.get("host_port_start", simulation.get("hostPortStart"))) is None
    ):
        raise TrainingCardError("simulation.host_port_start must be a positive integer")


def validate_card_supply(card: JsonObject) -> None:
    raw = card.get("card_supply", card.get("cardSupply"))
    if raw is None:
        return
    if not isinstance(raw, dict):
        raise TrainingCardError("card_supply must be an object")
    if raw.get("type") != LOOP_A_CARD_SUPPLY_TYPE:
        raise TrainingCardError(f"card_supply.type must be {LOOP_A_CARD_SUPPLY_TYPE}")
    if raw.get("consumer") != LOOP_A_CARD_SUPPLY_CONSUMER:
        raise TrainingCardError(f"card_supply.consumer must be {LOOP_A_CARD_SUPPLY_CONSUMER}")
    state = raw.get("state")
    if state not in LOOP_A_CARD_SUPPLY_STATES:
        raise TrainingCardError("card_supply.state must be available or consumed")
    if raw.get("dataset_run_id") != card.get("dataset_run_id", card.get("datasetRunId")):
        raise TrainingCardError("card_supply.dataset_run_id must match dataset_run_id")
    if raw.get("training_approach") != card.get("training_approach", card.get("trainingApproach")):
        raise TrainingCardError("card_supply.training_approach must match training_approach")
    if raw.get("safety_status") != "shadow":
        raise TrainingCardError("card_supply.safety_status must be shadow")
    if raw.get("status_field") != "status":
        raise TrainingCardError("card_supply.status_field must be status")
    created_at = raw.get("created_at")
    if not isinstance(created_at, str) or not ISO_TIMESTAMP_RE.fullmatch(created_at):
        raise TrainingCardError("card_supply.created_at must be an ISO UTC timestamp")

    if state == LOOP_A_CARD_SUPPLY_AVAILABLE:
        if card.get("status") != "shadow":
            raise TrainingCardError("available Loop A card supply requires status=shadow")
        if card.get("training_approach", card.get("trainingApproach")) != "policy_gradient":
            raise TrainingCardError("available Loop A card supply requires training_approach=policy_gradient")
        if raw.get("available_for_training") is not True:
            raise TrainingCardError("card_supply.available_for_training must be true for available supply")
        if raw.get("consumed_at") is not None:
            raise TrainingCardError("available Loop A card supply must not set consumed_at")
        if raw.get("consumed_by_report_id") is not None:
            raise TrainingCardError("available Loop A card supply must not set consumed_by_report_id")
    else:
        if raw.get("available_for_training") is not False:
            raise TrainingCardError("consumed Loop A card supply must set available_for_training=false")
        consumed_at = raw.get("consumed_at")
        if not isinstance(consumed_at, str) or not ISO_TIMESTAMP_RE.fullmatch(consumed_at):
            raise TrainingCardError("consumed Loop A card supply requires consumed_at")
        if not isinstance(raw.get("consumed_by_report_id"), str) or not raw.get("consumed_by_report_id"):
            raise TrainingCardError("consumed Loop A card supply requires consumed_by_report_id")


def raw_variant_definitions(card: JsonObject) -> Any:
    for key in ("strategy_variants", "strategyVariants", "variants"):
        if key in card:
            return card[key]
    return None


def raw_mapping(value: Any, label: str) -> JsonObject:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise TrainingCardError(f"{label} must be an object")
    return value


def first_present(raw: JsonObject, keys: Sequence[str]) -> Any:
    for key in keys:
        if key in raw:
            return raw[key]
    return None


def load_strategy_variants(card: JsonObject, registry_path: Path | None = None) -> list[StrategyVariant]:
    """Resolve strategy variants from the TS registry and inline card definitions."""
    registry = load_strategy_registry(registry_path or simulator_harness.DEFAULT_STRATEGY_REGISTRY_PATH)
    variants: list[StrategyVariant] = []
    seen: set[str] = set()
    for raw in raw_variant_definitions(card):
        variant = normalize_variant(raw, registry)
        if variant.id in seen:
            raise TrainingCardError(f"duplicate strategy variant id: {variant.id}")
        seen.add(variant.id)
        variants.append(variant)
    return variants


def expand_scale_environment_strategy_variants(
    variants: Sequence[StrategyVariant],
    environment_count: int | None,
) -> list[StrategyVariant]:
    """Clone strategy metadata into unique simulator rows for scale validation."""
    if environment_count is None:
        return list(variants)
    expanded_ids = simulator_harness.expand_scale_environment_variants(
        [variant.id for variant in variants],
        environment_count,
    )
    variants_by_id = {variant.id: variant for variant in variants}
    expanded: list[StrategyVariant] = []
    for variant_id in expanded_ids:
        base_id = simulator_harness.scale_environment_base_variant_id(variant_id)
        base = variants_by_id.get(base_id)
        if base is None:
            raise TrainingCardError(f"scale environment base variant {base_id!r} was not found")
        if variant_id == base.id:
            expanded.append(base)
            continue
        environment_index = simulator_harness.scale_environment_index(variant_id)
        suffix = f" scale environment {environment_index}" if environment_index is not None else " scale environment"
        expanded.append(
            StrategyVariant(
                id=variant_id,
                parameters=copy.deepcopy(base.parameters),
                candidate_policy_id=base.candidate_policy_id,
                family=base.family,
                parameter_evidence=copy.deepcopy(base.parameter_evidence),
                rollout_status=base.rollout_status,
                source_strategy_id=base.source_strategy_id,
                source=base.source,
                title=(base.title + suffix) if base.title else None,
                training_role=base.training_role,
            )
        )
    return expanded


def normalize_variant(raw: Any, registry: dict[str, StrategyVariant]) -> StrategyVariant:
    if isinstance(raw, str):
        variant_id = validate_strategy_id(raw)
        registry_variant = registry.get(variant_id)
        if registry_variant is None:
            raise TrainingCardError(f"strategy variant {variant_id!r} is not inline and was not found in registry")
        return registry_variant

    if not isinstance(raw, dict):
        raise TrainingCardError("strategy variant entries must be strings or objects")
    variant_id = validate_strategy_id(require_text(raw, "id"))
    registry_variant = registry.get(variant_id)
    source = "inline"
    parameters = first_mapping(raw, ("parameters", "params", "defaultValues", "default_values"))
    if parameters is None and registry_variant is not None:
        parameters = registry_variant.parameters
        source = registry_variant.source
    if parameters is None:
        parameters = {}
    candidate_policy_id = text_or_none(raw.get("candidatePolicyId")) or text_or_none(raw.get("candidate_policy_id"))
    if candidate_policy_id is not None:
        validate_strategy_id(candidate_policy_id)
    source_strategy_id = text_or_none(raw.get("sourceStrategyId")) or text_or_none(raw.get("source_strategy_id"))
    if source_strategy_id is not None:
        validate_strategy_id(source_strategy_id)
    family = text_or_none(raw.get("family")) or (registry_variant.family if registry_variant else None)
    parameter_evidence = first_mapping(raw, ("parameterEvidence", "parameter_evidence"))
    rollout_status = (
        text_or_none(raw.get("rolloutStatus"))
        or text_or_none(raw.get("rollout_status"))
        or (registry_variant.rollout_status if registry_variant else None)
    )
    title = text_or_none(raw.get("title")) or (registry_variant.title if registry_variant else None)
    return StrategyVariant(
        id=variant_id,
        parameters=dict(sorted(parameters.items())),
        candidate_policy_id=candidate_policy_id,
        family=family,
        parameter_evidence=copy.deepcopy(parameter_evidence) if parameter_evidence is not None else None,
        rollout_status=rollout_status,
        source_strategy_id=source_strategy_id,
        source=source,
        title=title,
        training_role=text_or_none(raw.get("trainingRole")) or text_or_none(raw.get("training_role")),
    )


def load_strategy_registry(path: Path) -> dict[str, StrategyVariant]:
    """Parse the existing TypeScript registry enough to recover ids and default parameter sets."""
    if not path.exists():
        return {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}

    text = mask_ts_comments_outside_strings(text)
    registry: dict[str, StrategyVariant] = {}
    for block in iter_registry_entry_blocks(text):
        variant_id = regex_group(r"\bid:\s*['\"]([^'\"]+)['\"]", block)
        if not variant_id:
            continue
        parameters = parse_ts_default_values(block)
        registry[variant_id] = StrategyVariant(
            id=variant_id,
            parameters=parameters,
            family=regex_group(r"\bfamily:\s*['\"]([^'\"]+)['\"]", block),
            rollout_status=regex_group(r"\brolloutStatus:\s*['\"]([^'\"]+)['\"]", block),
            title=regex_group(r"\btitle:\s*['\"]([^'\"]+)['\"]", block),
            source="registry",
        )
    return registry


def mask_ts_comments_outside_strings(text: str) -> str:
    """Replace TypeScript comments with whitespace without touching quoted content."""
    masked: list[str] = []
    index = 0
    quote: str | None = None
    escaped = False
    while index < len(text):
        char = text[index]
        next_char = text[index + 1] if index + 1 < len(text) else ""
        if quote:
            masked.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            index += 1
            continue
        if char in ("'", '"', "`"):
            quote = char
            masked.append(char)
            index += 1
            continue
        if char == "/" and next_char == "/":
            masked.extend((" ", " "))
            index += 2
            while index < len(text) and text[index] not in "\r\n":
                masked.append(" ")
                index += 1
            continue
        if char == "/" and next_char == "*":
            masked.extend((" ", " "))
            index += 2
            while index < len(text):
                if text[index] == "*" and index + 1 < len(text) and text[index + 1] == "/":
                    masked.extend((" ", " "))
                    index += 2
                    break
                masked.append(text[index] if text[index] in "\r\n" else " ")
                index += 1
            continue
        masked.append(char)
        index += 1
    return "".join(masked)


def iter_registry_entry_blocks(text: str) -> list[str]:
    blocks: list[str] = []
    for match in re.finditer(r"^\s*\{\s*\n\s*id:\s*['\"][^'\"]+['\"]", text, re.MULTILINE):
        start = match.start()
        end = find_matching_brace(text, start)
        if end is not None:
            blocks.append(text[start : end + 1])
    return blocks


def find_matching_brace(text: str, start: int) -> int | None:
    depth = 0
    quote: str | None = None
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in ("'", '"', "`"):
            quote = char
            continue
        if char == "{":
            depth += 1
            continue
        if char == "}":
            depth -= 1
            if depth == 0:
                return index
    return None


def parse_ts_default_values(block: str) -> JsonObject:
    match = re.search(r"\bdefaultValues:\s*\{", block)
    if not match:
        return {}
    start = block.find("{", match.start())
    end = find_matching_brace(block, start)
    if end is None:
        return {}
    body = block[start + 1 : end]
    values: JsonObject = {}
    for item in re.finditer(r"([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^,\n}]+)", body):
        values[item.group(1)] = parse_ts_scalar(item.group(2).strip())
    return dict(sorted(values.items()))


def parse_ts_scalar(raw: str) -> Any:
    stripped = raw.rstrip(",").strip()
    if stripped in {"true", "false"}:
        return stripped == "true"
    if (stripped.startswith("'") and stripped.endswith("'")) or (stripped.startswith('"') and stripped.endswith('"')):
        return stripped[1:-1]
    try:
        parsed = float(stripped) if "." in stripped else int(stripped)
    except ValueError:
        return stripped
    return parsed


def regex_group(pattern: str, text: str) -> str | None:
    match = re.search(pattern, text)
    return match.group(1) if match else None


def require_text(raw: JsonObject, field: str) -> str:
    value = raw.get(field)
    if not isinstance(value, str) or not value:
        raise TrainingCardError(f"strategy variant {field} must be a non-empty string")
    return value


def validate_strategy_id(value: str) -> str:
    if not STRATEGY_ID_RE.fullmatch(value) or value in {".", ".."}:
        raise TrainingCardError("strategy variant id may contain only letters, numbers, dot, colon, underscore, and hyphen")
    return value


def first_mapping(raw: JsonObject, keys: Sequence[str]) -> JsonObject | None:
    for key in keys:
        value = raw.get(key)
        if isinstance(value, dict):
            return value
    return None


def simulation_config_from_card(card: JsonObject) -> SimulationConfig:
    simulation = raw_mapping(card.get("simulation", card.get("simulator", {})), "simulation")
    return SimulationConfig(
        ticks=positive_int_value(simulation.get("ticks")) or simulator_harness.DEFAULT_RUN_TICKS,
        workers=positive_int_value(simulation.get("workers")) or simulator_harness.DEFAULT_RUN_WORKERS,
        repetitions=positive_int_value(simulation.get("repetitions")) or DEFAULT_RUN_REPETITIONS,
        host_port_start=positive_int_value(
            simulation.get("host_port_start", simulation.get("hostPortStart"))
        )
        or simulator_harness.resolve_run_host_port_start(None),
        room=text_or_none(simulation.get("room")) or simulator_harness.DEFAULT_SIM_ROOM,
        shard=text_or_none(simulation.get("shard")) or simulator_harness.DEFAULT_SIM_SHARD,
        branch=text_or_none(simulation.get("branch")) or simulator_harness.DEFAULT_ACTIVE_WORLD_BRANCH,
        code_path=Path(text_or_none(simulation.get("code_path")) or text_or_none(simulation.get("codePath")) or simulator_harness.DEFAULT_CODE_PATH),
        map_source_file=Path(
            text_or_none(simulation.get("map_source_file"))
            or text_or_none(simulation.get("mapSourceFile"))
            or simulator_harness.DEFAULT_MAP_SOURCE_FILE
        ),
        simulator_out_dir=Path(
            text_or_none(simulation.get("simulator_out_dir"))
            or text_or_none(simulation.get("simulatorOutDir"))
            or simulator_harness.DEFAULT_RUN_OUT_DIR
        ),
        scale_environments=positive_int_value(
            simulation.get("scale_environments", simulation.get("scaleEnvironments"))
        ),
        min_concurrent_environments=positive_int_value(
            simulation.get("min_concurrent_environments", simulation.get("minConcurrentEnvironments"))
        ),
    )


def positive_int_value(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value > 0:
        return value
    if isinstance(value, float) and math.isfinite(value) and value.is_integer() and value > 0:
        return int(value)
    if isinstance(value, str):
        try:
            parsed = int(value)
        except ValueError:
            return None
        return parsed if parsed > 0 else None
    return None


def text_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def reward_options_from_card(card: JsonObject) -> JsonObject:
    reward_model = raw_mapping(card.get("reward_model", card.get("rewardModel", {})), "reward_model")
    weights = reward_model.get("component_weights", reward_model.get("componentWeights"))
    if not isinstance(weights, dict):
        weights = {}
    normalizers = reward_model.get("normalizers")
    if not isinstance(normalizers, dict):
        normalizers = {}
    return {
        "componentOrder": list(REWARD_TIERS),
        "weights": weights,
        "resourceNormalizer": positive_float_value(
            reward_model.get("resource_normalizer", reward_model.get("resourceNormalizer", normalizers.get("resources")))
        )
        or DEFAULT_RESOURCE_NORMALIZER,
    }


def positive_float_value(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value) and value > 0:
        return float(value)
    if isinstance(value, str):
        try:
            parsed = float(value)
        except ValueError:
            return None
        return parsed if math.isfinite(parsed) and parsed > 0 else None
    return None


def run_training_experiment(
    card_path: Path,
    out_dir: Path = DEFAULT_OUT_DIR,
    *,
    report_id: str | None = None,
    generated_at: str | None = None,
    registry_path: Path | None = None,
    simulator_runner: SimulatorRunner = simulator_harness.run_simulator,
    steam_key_env_file: Path | None = None,
    stdout: TextIO | None = None,
) -> JsonObject:
    """Run all card variants through the simulator harness and write a JSON report."""
    card = load_experiment_card(card_path)
    variants = load_strategy_variants(card, registry_path=registry_path)
    config = simulation_config_from_card(card)
    variants = expand_scale_environment_strategy_variants(variants, config.scale_environments)
    reward_options = reward_options_from_card(card)
    resolved_report_id = report_id or default_report_id(card, variants, config)
    validate_report_id(resolved_report_id)
    ensure_steam_key_for_training(simulator_runner=simulator_runner, env_file=steam_key_env_file)

    simulator_runs = execute_simulator_runs(
        simulator_runner=simulator_runner,
        variants=variants,
        config=config,
        card=card,
        report_id=resolved_report_id,
    )
    assert_simulator_runs_shadow_safe(simulator_runs)
    report = build_training_report(
        card=card,
        card_path=card_path,
        variants=variants,
        config=config,
        simulator_runs=simulator_runs,
        reward_options=reward_options,
        report_id=resolved_report_id,
        generated_at=generated_at or utc_now_iso(),
    )
    report_secret_values = dataset_export.configured_secret_values() + [os.environ.get("STEAM_KEY", "")]
    assert_no_secret_leak(report, report_secret_values)
    report_path = out_dir.expanduser() / f"{resolved_report_id}.json"
    policy_artifacts = materialize_policy_update_artifacts(report, report_path.parent)
    for _artifact_path, artifact_payload in policy_artifacts:
        assert_no_secret_leak(artifact_payload, report_secret_values)
    assert_no_secret_leak(report, report_secret_values)
    for artifact_path, artifact_payload in policy_artifacts:
        write_json_atomic(artifact_path, artifact_payload)
    write_json_atomic(report_path, report)
    report["reportPath"] = dataset_export.display_path(report_path)
    if stdout is not None:
        stdout.write(canonical_json(build_generation_summary(report)))
    return report


def execute_simulator_runs(
    *,
    simulator_runner: SimulatorRunner,
    variants: Sequence[StrategyVariant],
    config: SimulationConfig,
    card: JsonObject,
    report_id: str,
) -> list[JsonObject]:
    variant_ids = [variant.id for variant in variants]
    raw_run_id = text_or_none(card.get("run_id")) or text_or_none(card.get("runId")) or report_id
    base_run_id = normalize_simulator_run_id(raw_run_id)
    runs: list[JsonObject] = []
    effective_workers = max(1, min(config.workers, len(variant_ids)))
    min_concurrent_environments = config.min_concurrent_environments or config.scale_environments or 0
    for repetition in range(config.repetitions):
        run_id = base_run_id if config.repetitions == 1 else f"{base_run_id}-r{repetition + 1:02d}"
        host_port_start = simulator_repetition_host_port_start(
            config.host_port_start,
            repetition,
            effective_workers,
        )
        runs.append(
            simulator_runner(
                ticks=config.ticks,
                workers=config.workers,
                variants=variant_ids,
                out_dir=config.simulator_out_dir,
                run_id=run_id,
                host_port_start=host_port_start,
                room=config.room,
                shard=config.shard,
                branch=config.branch,
                code_path=config.code_path,
                map_source_file=config.map_source_file,
                min_concurrent_environments=min_concurrent_environments,
            )
        )
    return runs


def simulator_repetition_host_port_start(base_host_port_start: int, repetition_index: int, effective_workers: int) -> int:
    if repetition_index < 0:
        raise ValueError("repetition_index must be non-negative")
    if effective_workers <= 0:
        raise ValueError("effective_workers must be a positive integer")
    attempts_per_run = 1 + simulator_harness.RUN_BROKEN_PIPE_MAX_RETRIES
    host_port_start = base_host_port_start + (
        repetition_index * effective_workers * simulator_harness.RUN_HTTP_PORT_STEP * attempts_per_run
    )
    last_cli_port = (
        host_port_start + (effective_workers * simulator_harness.RUN_HTTP_PORT_STEP * attempts_per_run) - 1
    )
    if last_cli_port > 65535:
        raise RuntimeError(f"simulator repetition host port range exceeds TCP port limit: {last_cli_port}")
    return host_port_start


def normalize_simulator_run_id(raw: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_-]+", "_", raw)
    normalized = re.sub(r"_+", "_", normalized).strip("_-")
    if not normalized:
        normalized = "rl_training"
    simulator_harness.validate_run_id_token(normalized)
    return normalized


def assert_simulator_runs_shadow_safe(simulator_runs: Sequence[JsonObject]) -> None:
    unsafe: list[str] = []
    for index, run in enumerate(simulator_runs):
        if not isinstance(run, dict):
            continue
        unsafe.extend(unsafe_simulator_flags(run, f"run[{index}]"))
        variants = run.get("variants")
        if isinstance(variants, list):
            for variant_index, variant in enumerate(variants):
                if isinstance(variant, dict):
                    unsafe.extend(unsafe_simulator_flags(variant, f"run[{index}].variants[{variant_index}]"))
    if unsafe:
        raise RuntimeError("refusing to persist unsafe RL training report: " + "; ".join(unsafe))


def unsafe_simulator_flags(payload: JsonObject, label: str) -> list[str]:
    unsafe: list[str] = []
    for field in ("liveEffect", "live_effect"):
        if payload.get(field) is True:
            unsafe.append(f"{label}.{field}=true")
    for field in (
        "officialMmoWrites",
        "official_mmo_writes",
        "officialMmoWritesAllowed",
        "official_mmo_writes_allowed",
    ):
        if payload.get(field) is True:
            unsafe.append(f"{label}.{field}=true")
    return unsafe


def build_scale_validation_summary(
    simulator_runs: Sequence[JsonObject],
    config: SimulationConfig,
) -> JsonObject | None:
    target = config.min_concurrent_environments or config.scale_environments
    if target is None:
        return None
    minimum_successful = math.ceil(target * simulator_harness.RUN_SCALE_VALIDATION_TARGET_SUCCESS_RATE)
    run_summaries: list[JsonObject] = []
    total_environments = 0
    successful_environments = 0
    for index, run in enumerate(simulator_runs):
        variants = run.get("variants") if isinstance(run, dict) else None
        rows = [item for item in variants if isinstance(item, dict)] if isinstance(variants, list) else []
        env_success: dict[str, bool] = {}
        for item in rows:
            environment_id = scale_validation_environment_id(item)
            env_success[environment_id] = env_success.get(environment_id, False) or item.get("ok") is True
        successful = sum(1 for ok in env_success.values() if ok)
        total = len(env_success)
        total_environments += total
        successful_environments += successful
        run_summaries.append({
            "runId": run.get("runId") if isinstance(run, dict) else f"run[{index}]",
            "totalEnvironments": total,
            "successfulEnvironments": successful,
            "ok": total >= target and successful >= minimum_successful,
        })
    return {
        "ok": bool(run_summaries) and all(item["ok"] for item in run_summaries),
        "targetEnvironments": target,
        "minimumSuccessRate": simulator_harness.RUN_SCALE_VALIDATION_TARGET_SUCCESS_RATE,
        "minimumSuccessfulEnvironments": minimum_successful,
        "totalEnvironments": total_environments,
        "successfulEnvironments": successful_environments,
        "failedEnvironments": total_environments - successful_environments,
        "repetitions": len(run_summaries),
        "perRun": run_summaries,
    }


def scale_validation_environment_id(variant: JsonObject) -> str:
    """Return a stable per-run environment id for scale-proof row counting."""
    for key in ("environmentId", "envId", "environment", "slot"):
        if key in variant and usable_environment_id_value(variant[key]):
            return f"{key}:{stable_identity_text(variant[key])}"

    for container in scale_validation_environment_containers(variant):
        for key in (
            "environmentId",
            "envId",
            "environment",
            "slot",
            "environmentIndex",
            "environment_index",
            "index",
        ):
            if key in container and usable_environment_id_value(container[key]):
                return f"{key}:{stable_identity_text(container[key])}"

    for key in ("variant_id", "variantId", "id"):
        value = variant.get(key)
        if isinstance(value, str) and value:
            return f"{key}:{value}"

    return "row:" + stable_identity_text(variant)


def usable_environment_id_value(value: Any) -> bool:
    return value is not None and not (isinstance(value, str) and not value)


def scale_validation_environment_containers(variant: JsonObject) -> list[JsonObject]:
    containers: list[JsonObject] = []
    for key in ("scaleEnvironment", "scale_environment"):
        value = variant.get(key)
        if isinstance(value, dict):
            containers.append(value)
    for key in ("strategyVariant", "strategy_variant"):
        value = variant.get(key)
        if not isinstance(value, dict):
            continue
        for nested_key in ("scaleEnvironment", "scale_environment"):
            nested = value.get(nested_key)
            if isinstance(nested, dict):
                containers.append(nested)
    return containers


def stable_identity_text(value: Any) -> str:
    try:
        return canonical_hash(value)
    except (TypeError, ValueError):
        return hashlib.sha256(repr(value).encode("utf-8")).hexdigest()


def build_training_report(
    *,
    card: JsonObject,
    card_path: Path,
    variants: Sequence[StrategyVariant],
    config: SimulationConfig,
    simulator_runs: Sequence[JsonObject],
    reward_options: JsonObject,
    report_id: str,
    generated_at: str,
) -> JsonObject:
    per_variant_runs = collect_variant_runs(simulator_runs, [variant.id for variant in variants])
    results = [
        summarize_variant(variant, per_variant_runs.get(variant.id, []), reward_options)
        for variant in variants
    ]
    scored_results = [result for result in results if result["sampleCount"] > 0]
    ranking = rank_variant_results(scored_results)
    incumbent_ids = incumbent_strategy_ids(variants)
    best_incumbent_reward_tuple = best_incumbent_reward_tuple_from_ranking(ranking, incumbent_ids)
    model_reports = build_shadow_compatible_model_reports(ranking, incumbent_ids, best_incumbent_reward_tuple)
    pairwise = build_pairwise_comparisons(scored_results)
    changed_top = bool(
        ranking and variant_strictly_beats_best_incumbent(ranking[0], incumbent_ids, best_incumbent_reward_tuple)
    )
    changed_top_count = 1 if changed_top else 0
    ranking_diff_count = sum(1 for item in pairwise if item.get("winner") and item["winner"] not in incumbent_ids)
    warnings = build_report_warnings(results, simulator_runs)
    scale_validation = build_scale_validation_summary(simulator_runs, config)
    policy_gradient = policy_gradient_metadata_from_card(card)
    scenario = scenario_metadata_from_card(card)
    if (
        policy_gradient is not None
        and scenario is not None
        and not scenario_supports_multi_tier_policy_comparison(scenario)
    ):
        warnings.append(
            "experiment card scenario is classified as not suitable for multi-tier territory/combat policy comparison"
        )

    report = {
        "type": REPORT_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "reportId": report_id,
        "generatedAt": generated_at,
        "owningIssue": "#549",
        "status": "shadow",
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
        "experimentCard": summarize_card(card, card_path),
        "simulation": config.to_json(),
        "source": {
            "experimentCardPath": dataset_export.display_path(card_path),
            "simulatorHarness": "scripts/screeps_rl_simulator_harness.py",
            "simulatorRunCount": len(simulator_runs),
            "simulatorRunIds": [
                run.get("runId")
                for run in simulator_runs
                if isinstance(run, dict) and isinstance(run.get("runId"), str)
            ],
            "initialConditions": {
                "ticks": config.ticks,
                "room": config.room,
                "shard": config.shard,
                "branch": config.branch,
                "mapSourceFile": str(config.map_source_file),
            },
        },
        "rewardModel": {
            "type": "lexicographic",
            "componentOrder": list(REWARD_TIERS),
            "resourceNormalizer": reward_options["resourceNormalizer"],
            "formula": (
                "compare (successful simulator run share, roomsGained - roomsLost, "
                "(storedEnergyDelta + collectedEnergy) / resourceNormalizer, "
                "hostileKills - ownLosses) lexicographically"
            ),
            "scalarWeightedSumAuthorized": False,
            "expansionSurvival": "claimed rooms count as held only with at least one spawn and one owned creep at end",
        },
        "strategyVariants": [variant.to_json() for variant in variants],
        "candidateStrategyIds": [variant.id for variant in variants],
        "incumbentStrategyIds": incumbent_ids,
        "artifactCount": sum(result["sampleCount"] for result in results),
        "variantResults": results,
        "ranking": ranking,
        "statisticalComparison": {
            "method": "per-variant deterministic simulator samples with lexicographic mean comparison",
            "sampleCountByVariant": {result["variantId"]: result["sampleCount"] for result in results},
            "componentMeans": {
                result["variantId"]: result["reward"]["tuple"]
                for result in scored_results
            },
            "pairwise": pairwise,
        },
        "modelReportCount": len(model_reports),
        "rankingDiffCount": ranking_diff_count,
        "changedTopCount": changed_top_count,
        "policyUpdateIterations": 0,
        "policyUpdateAlgorithm": None,
        "policyUpdateCandidatePolicyId": None,
        "trueGradient": False,
        "modelFamilies": sorted({text for text in (result.get("family") for result in results) if isinstance(text, str)}),
        "modelReports": model_reports,
        "kpiSummary": build_kpi_summary(scored_results),
        "warnings": warnings,
    }
    if scenario is not None:
        report["scenario"] = scenario
        activation_proof = build_multi_tier_activation_proof(
            results=results,
            scenario=scenario,
            kpi_summary=report["kpiSummary"],
        )
        if activation_proof is not None:
            report["activationProof"] = activation_proof
            if activation_proof["status"] == "blocked":
                warnings.append(
                    "multi-tier activation proof blocked: "
                    f"{activation_proof['blocker']['classification']}"
                )
    if scale_validation is not None:
        report["scaleValidation"] = scale_validation
    if policy_gradient is not None:
        report["policyGradient"] = policy_gradient
        policy_update = build_policy_update(
            policy_gradient=policy_gradient,
            results=results,
            report_id=report_id,
            generated_at=generated_at,
        )
        report["policyUpdateIterations"] = int(policy_update.get("iterations", 0))
        policy_update_algorithm_name = text_or_none(policy_update.get("algorithm"))
        report["policyUpdateAlgorithm"] = policy_update_algorithm_name
        report["trueGradient"] = (
            policy_update_algorithm_name == TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM
            or policy_update.get("trueGradient") is True
        )
        next_candidate_policy = policy_update.get("nextCandidatePolicy")
        if isinstance(next_candidate_policy, dict):
            report["policyUpdateCandidatePolicyId"] = text_or_none(next_candidate_policy.get("candidatePolicyId"))
        report["policyUpdate"] = policy_update
    return report


def build_policy_update(
    *,
    policy_gradient: JsonObject,
    results: Sequence[JsonObject],
    report_id: str,
    generated_at: str,
) -> JsonObject:
    """Compute one bounded offline policy update from rollout rewards."""
    algorithm = policy_update_algorithm(policy_gradient)
    if algorithm == TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM:
        return build_reinforce_policy_update(
            policy_gradient=policy_gradient,
            results=results,
            report_id=report_id,
            generated_at=generated_at,
        )
    if algorithm == RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM:
        return build_rank_weighted_finite_difference_policy_update(
            policy_gradient=policy_gradient,
            results=results,
            report_id=report_id,
            generated_at=generated_at,
        )
    raise TrainingCardError(f"unsupported policy update algorithm: {algorithm}")


def build_policy_update_base(*, algorithm: str, target_family: str) -> JsonObject:
    return {
        "type": "screeps-rl-policy-update",
        "schemaVersion": SCHEMA_VERSION,
        "iterations": 0,
        "algorithm": algorithm,
        "targetFamily": target_family,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }


def build_rank_weighted_finite_difference_policy_update(
    *,
    policy_gradient: JsonObject,
    results: Sequence[JsonObject],
    report_id: str,
    generated_at: str,
) -> JsonObject:
    target_family = text_or_none(policy_gradient.get("target_family", policy_gradient.get("targetFamily"))) or "unknown"
    parameter_space = policy_update_parameter_space(policy_gradient)
    candidates = policy_update_candidate_rows(policy_gradient, results, parameter_space)
    base = build_policy_update_base(algorithm=RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM, target_family=target_family)
    if not parameter_space:
        return {**base, "skippedReason": "missing_policy_parameter_space"}
    if len(candidates) < 2:
        return {**base, "skippedReason": "fewer_than_two_scored_policy_candidates", "candidateCount": len(candidates)}

    anchor = policy_update_anchor_candidate(candidates)
    if anchor is None:
        return {**base, "skippedReason": "missing_anchor_policy_candidate", "candidateCount": len(candidates)}

    utilities = policy_update_reward_utilities(candidates)
    anchor_utility = utilities.get(anchor["strategyVariantId"])
    if anchor_utility is None:
        return {**base, "skippedReason": "missing_anchor_reward_utility", "candidateCount": len(candidates)}
    advantages = {
        row["strategyVariantId"]: round_policy_number(float(utility) - float(anchor_utility))
        for row in candidates
        for utility in [utilities.get(row["strategyVariantId"])]
        if utility is not None
    }
    denominator = sum(abs(float(value)) for value in advantages.values())
    if denominator <= 0:
        return {
            **base,
            "skippedReason": "no_nonzero_reward_advantage",
            "candidateCount": len(candidates),
            "anchor": policy_update_candidate_summary(anchor),
            "candidateRewards": [policy_update_candidate_summary(row) for row in candidates],
        }

    learning_rate = policy_update_learning_rate(policy_gradient)
    anchor_parameters = anchor["parameters"]
    gradient: JsonObject = {}
    updated_parameters: JsonObject = {}
    parameter_delta: JsonObject = {}
    for name in parameter_space:
        anchor_value = float(anchor_parameters[name])
        raw_gradient = 0.0
        for row in candidates:
            advantage = float(advantages.get(row["strategyVariantId"], 0))
            raw_gradient += advantage * (float(row["parameters"][name]) - anchor_value)
        raw_gradient /= denominator
        gradient[name] = round_policy_number(raw_gradient)
        updated = bounded_policy_parameter_value(
            anchor_value + (learning_rate * raw_gradient),
            parameter_space[name],
        )
        updated_parameters[name] = updated
        parameter_delta[name] = round_policy_number(float(updated) - anchor_value)

    if not any(abs(float(value)) > 0 for value in parameter_delta.values()):
        return {
            **base,
            "skippedReason": "bounded_update_no_parameter_change",
            "candidateCount": len(candidates),
            "anchor": policy_update_candidate_summary(anchor),
            "candidateRewards": [policy_update_candidate_summary(row) for row in candidates],
            "learningRate": learning_rate,
            "gradient": gradient,
        }

    candidate_policy_id = updated_candidate_policy_id(
        target_family=target_family,
        report_id=report_id,
        parameters=updated_parameters,
    )
    next_candidate_policy = {
        "type": "screeps-rl-next-candidate-policy",
        "schemaVersion": SCHEMA_VERSION,
        "candidatePolicyId": candidate_policy_id,
        "strategyVariantId": candidate_policy_id,
        "family": target_family,
        "rolloutStatus": "shadow",
        "trainingRole": "policy_gradient_updated_candidate",
        "generatedAt": generated_at,
        "sourceReportId": report_id,
        "sourcePolicyUpdateAlgorithm": RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM,
        "policyUpdateAlgorithm": RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM,
        "trueGradient": False,
        "sourceAnchorCandidatePolicyId": anchor.get("candidatePolicyId"),
        "sourceAnchorStrategyVariantId": anchor.get("strategyVariantId"),
        "policyUpdateIterations": 1,
        "parameters": updated_parameters,
        "parameterEvidence": {
            "derivation": "rank-weighted bounded finite-difference update from offline simulator rollout rewards",
            "targetFamily": target_family,
            "learnableKnobs": list(parameter_space),
            "anchorParameters": copy.deepcopy(anchor_parameters),
            "gradient": copy.deepcopy(gradient),
            "parameterDelta": copy.deepcopy(parameter_delta),
            "learningRate": learning_rate,
            "candidateCount": len(candidates),
            "policyUpdateAlgorithm": RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM,
            "trueGradient": False,
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        },
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }
    return {
        **base,
        "iterations": 1,
        "policyUpdateAlgorithm": RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM,
        "trueGradient": False,
        "learningRate": learning_rate,
        "parameterSpace": copy.deepcopy(parameter_space),
        "candidateCount": len(candidates),
        "anchor": policy_update_candidate_summary(anchor),
        "candidateRewards": [policy_update_candidate_summary(row) for row in candidates],
        "advantageByStrategyVariantId": advantages,
        "gradient": gradient,
        "parameterDelta": parameter_delta,
        "updatedParameters": updated_parameters,
        "nextCandidatePolicy": next_candidate_policy,
    }


def build_reinforce_policy_update(
    *,
    policy_gradient: JsonObject,
    results: Sequence[JsonObject],
    report_id: str,
    generated_at: str,
) -> JsonObject:
    target_family = text_or_none(policy_gradient.get("target_family", policy_gradient.get("targetFamily"))) or "unknown"
    parameter_space = policy_update_parameter_space(policy_gradient)
    candidates = policy_update_candidate_rows(policy_gradient, results, parameter_space)
    base = build_policy_update_base(algorithm=TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM, target_family=target_family)
    if not parameter_space:
        return {**base, "skippedReason": "missing_policy_parameter_space"}
    if len(candidates) < 2:
        return {**base, "skippedReason": "fewer_than_two_scored_policy_candidates", "candidateCount": len(candidates)}

    anchor = policy_update_anchor_candidate(candidates)
    if anchor is None:
        return {**base, "skippedReason": "missing_anchor_policy_candidate", "candidateCount": len(candidates)}

    samples = policy_update_return_sample_rows(candidates)
    if len(samples) < 2:
        return {
            **base,
            "skippedReason": "fewer_than_two_monte_carlo_return_samples",
            "candidateCount": len(candidates),
            "anchor": policy_update_candidate_summary(anchor),
            "candidateRewards": [policy_update_candidate_summary(row) for row in candidates],
        }

    return_baseline = mean_policy_return_tuple([sample["returnTuple"] for sample in samples])
    learning_rate = policy_update_learning_rate(policy_gradient)
    anchor_parameters = anchor["parameters"]
    gradient_by_tier: JsonObject = {}
    gradient: JsonObject = {}
    selected_reward_tier_by_parameter: JsonObject = {}
    updated_parameters: JsonObject = {}
    parameter_delta: JsonObject = {}

    for name, spec in parameter_space.items():
        anchor_value = float(anchor_parameters[name])
        span = max(float(spec["max"]) - float(spec["min"]), 1.0)
        tier_gradients: dict[str, float | int] = {}
        for tier_index, tier in enumerate(REWARD_TIERS):
            raw_gradient = 0.0
            for sample in samples:
                row = sample["candidate"]
                normalized_delta = (float(row["parameters"][name]) - anchor_value) / span
                advantage = float(sample["returnTuple"][tier_index]) - float(return_baseline[tier_index])
                raw_gradient += advantage * normalized_delta
            tier_gradients[tier] = round_policy_number(raw_gradient / len(samples))
        selected_tier, selected_gradient = first_nonzero_tier_gradient(tier_gradients)
        selected_reward_tier_by_parameter[name] = selected_tier
        gradient_by_tier[name] = tier_gradients
        gradient[name] = selected_gradient
        updated = bounded_policy_parameter_value(
            anchor_value + (learning_rate * float(selected_gradient) * span),
            spec,
        )
        updated_parameters[name] = updated
        parameter_delta[name] = round_policy_number(float(updated) - anchor_value)

    return_summary = policy_update_return_summary(
        candidates=candidates,
        samples=samples,
        baseline=return_baseline,
    )
    if not any(abs(float(value)) > 0 for value in parameter_delta.values()):
        return {
            **base,
            "skippedReason": "bounded_update_no_parameter_change",
            "candidateCount": len(candidates),
            "anchor": policy_update_candidate_summary(anchor),
            "candidateRewards": [policy_update_candidate_summary(row) for row in candidates],
            "learningRate": learning_rate,
            "gradient": gradient,
        }

    candidate_policy_id = updated_candidate_policy_id(
        target_family=target_family,
        report_id=report_id,
        parameters=updated_parameters,
    )
    next_candidate_policy = {
        "type": "screeps-rl-next-candidate-policy",
        "schemaVersion": SCHEMA_VERSION,
        "candidatePolicyId": candidate_policy_id,
        "strategyVariantId": candidate_policy_id,
        "family": target_family,
        "rolloutStatus": "shadow",
        "trainingRole": "policy_gradient_updated_candidate",
        "generatedAt": generated_at,
        "sourceReportId": report_id,
        "sourcePolicyUpdateAlgorithm": TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM,
        "policyUpdateAlgorithm": TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM,
        "trueGradient": True,
        "sourceAnchorCandidatePolicyId": anchor.get("candidatePolicyId"),
        "sourceAnchorStrategyVariantId": anchor.get("strategyVariantId"),
        "policyUpdateIterations": 1,
        "parameters": updated_parameters,
        "parameterEvidence": {
            "derivation": (
                "deterministic REINFORCE score-function estimate from offline simulator "
                "Monte Carlo reward-tuple returns with a mean-return baseline"
            ),
            "targetFamily": target_family,
            "learnableKnobs": list(parameter_space),
            "anchorParameters": copy.deepcopy(anchor_parameters),
            "gradient": copy.deepcopy(gradient),
            "gradientByRewardTier": copy.deepcopy(gradient_by_tier),
            "selectedRewardTierByParameter": copy.deepcopy(selected_reward_tier_by_parameter),
            "parameterDelta": copy.deepcopy(parameter_delta),
            "learningRate": learning_rate,
            "returnBaseline": copy.deepcopy(return_baseline),
            "returnSampleCount": len(samples),
            "candidateCount": len(candidates),
            "policyUpdateAlgorithm": TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM,
            "trueGradient": True,
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        },
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }
    return {
        **base,
        "iterations": 1,
        "policyUpdateAlgorithm": TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM,
        "trueGradient": True,
        "policyGradientEstimator": "score_function_reinforce_v1",
        "learningRate": learning_rate,
        "parameterSpace": copy.deepcopy(parameter_space),
        "candidateCount": len(candidates),
        "anchor": policy_update_candidate_summary(anchor),
        "candidateRewards": [policy_update_candidate_summary(row) for row in candidates],
        "returnSummary": return_summary,
        "gradient": gradient,
        "gradientByRewardTier": gradient_by_tier,
        "selectedRewardTierByParameter": selected_reward_tier_by_parameter,
        "parameterDelta": parameter_delta,
        "updatedParameters": updated_parameters,
        "nextCandidatePolicy": next_candidate_policy,
    }


def policy_update_algorithm(policy_gradient: JsonObject) -> str:
    for raw in policy_update_config_candidates(policy_gradient):
        for key in ("algorithm", "policy_update_algorithm", "policyUpdateAlgorithm"):
            value = text_or_none(raw.get(key))
            if value is not None:
                if value in {TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM, RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM}:
                    return value
                raise TrainingCardError(f"unsupported policy update algorithm: {value}")
    return DEFAULT_POLICY_UPDATE_ALGORITHM


def policy_update_config_candidates(policy_gradient: JsonObject) -> list[JsonObject]:
    configs = [policy_gradient]
    for key in ("policy_update", "policyUpdate", "update", "update_config", "updateConfig"):
        raw = policy_gradient.get(key)
        if isinstance(raw, dict):
            configs.append(raw)
    return configs


def policy_update_return_sample_rows(candidates: Sequence[JsonObject]) -> list[JsonObject]:
    samples: list[JsonObject] = []
    for row in candidates:
        raw_samples = row.get("returnSamples")
        if not isinstance(raw_samples, list):
            continue
        for return_tuple in raw_samples:
            if not isinstance(return_tuple, list):
                continue
            samples.append({"candidate": row, "returnTuple": return_tuple})
    return samples


def policy_update_return_summary(
    *,
    candidates: Sequence[JsonObject],
    samples: Sequence[JsonObject],
    baseline: Sequence[float | int],
) -> JsonObject:
    return {
        "type": "monte_carlo_reward_tuple_returns",
        "componentOrder": list(REWARD_TIERS),
        "baseline": list(baseline),
        "sampleCount": len(samples),
        "baselineType": "mean_return",
        "candidateReturns": [
            {
                "candidatePolicyId": row.get("candidatePolicyId"),
                "strategyVariantId": row.get("strategyVariantId"),
                "rolloutStatus": row.get("rolloutStatus"),
                "meanReturn": copy.deepcopy(row.get("meanReturn")),
                "returnSampleCount": row.get("returnSampleCount"),
                "rewardTuple": copy.deepcopy(row.get("rewardTuple")),
                "sampleCount": row.get("sampleCount"),
            }
            for row in candidates
        ],
    }


def first_nonzero_tier_gradient(tier_gradients: JsonObject) -> tuple[str | None, float | int]:
    for tier in REWARD_TIERS:
        value = tier_gradients.get(tier, 0)
        if abs(float(value)) > 1e-12:
            return tier, value
    return None, 0


def mean_policy_return_tuple(return_tuples: Sequence[Sequence[Any]]) -> list[float | int]:
    if not return_tuples:
        return [0 for _tier in REWARD_TIERS]
    columns = list(zip(*return_tuples))
    return [round_policy_number(statistics.fmean(float(value) for value in column)) for column in columns]


def policy_update_parameter_space(policy_gradient: JsonObject) -> dict[str, JsonObject]:
    learnable = first_present(policy_gradient, ("learnable_parameters", "learnableParameters"))
    space: dict[str, JsonObject] = {}
    if not isinstance(learnable, list):
        return space
    for item in learnable:
        if not isinstance(item, dict):
            continue
        name = text_or_none(item.get("name"))
        minimum = number_or_none(item.get("min"))
        maximum = number_or_none(item.get("max"))
        step = number_or_none(item.get("step"))
        if name is None or minimum is None or maximum is None:
            continue
        minimum_float = float(minimum)
        maximum_float = float(maximum)
        if minimum_float > maximum_float:
            continue
        spec: JsonObject = {
            "min": round_policy_number(minimum_float),
            "max": round_policy_number(maximum_float),
        }
        if step is not None and float(step) > 0:
            spec["step"] = round_policy_number(float(step))
        space[name] = spec
    return space


def policy_update_candidate_rows(
    policy_gradient: JsonObject,
    results: Sequence[JsonObject],
    parameter_space: dict[str, JsonObject],
) -> list[JsonObject]:
    raw_candidates = first_present(policy_gradient, ("candidate_parameter_vectors", "candidateParameterVectors"))
    if not isinstance(raw_candidates, list):
        return []
    result_groups: dict[str, list[JsonObject]] = {}
    for result in results:
        variant_id = text_or_none(result.get("variantId"))
        if variant_id is None:
            continue
        base_id = simulator_harness.scale_environment_base_variant_id(variant_id)
        result_groups.setdefault(base_id, []).append(result)

    rows: list[JsonObject] = []
    for candidate in raw_candidates:
        if not isinstance(candidate, dict):
            continue
        strategy_variant_id = text_or_none(candidate.get("strategyVariantId"))
        candidate_policy_id = text_or_none(candidate.get("candidatePolicyId"))
        if strategy_variant_id is None:
            continue
        summaries = result_groups.get(strategy_variant_id) or result_groups.get(candidate_policy_id or "") or []
        scored_summaries = [summary for summary in summaries if policy_reward_tuple_values(summary) is not None]
        if not scored_summaries:
            continue
        card_parameters = bounded_policy_parameters(candidate.get("parameters"), parameter_space)
        parameters = policy_update_evaluated_parameters(
            candidate=candidate,
            scored_summaries=scored_summaries,
            card_parameters=card_parameters,
            parameter_space=parameter_space,
        )
        if parameters is None:
            continue
        return_samples = policy_update_return_samples(scored_summaries)
        rows.append(
            {
                "candidatePolicyId": candidate_policy_id,
                "strategyVariantId": strategy_variant_id,
                "sourceStrategyId": text_or_none(candidate.get("sourceStrategyId")),
                "rolloutStatus": text_or_none(candidate.get("rolloutStatus")),
                "parameters": parameters,
                "rewardTuple": aggregate_policy_reward_tuple(scored_summaries),
                "sampleCount": sum(policy_reward_tuple_sample_weight(summary) for summary in scored_summaries),
                "returnSamples": return_samples,
                "returnSampleCount": len(return_samples),
                "meanReturn": mean_policy_return_tuple(return_samples),
                "resultVariantIds": [summary["variantId"] for summary in scored_summaries if isinstance(summary.get("variantId"), str)],
            }
        )
    return rows


def policy_update_evaluated_parameters(
    *,
    candidate: JsonObject,
    scored_summaries: Sequence[JsonObject],
    card_parameters: JsonObject | None,
    parameter_space: dict[str, JsonObject],
) -> JsonObject | None:
    evaluated: list[JsonObject] = []
    missing_evaluated: list[str] = []
    for summary in scored_summaries:
        source = policy_update_summary_parameter_source(summary)
        variant_id = text_or_none(summary.get("variantId")) or "<unknown>"
        if source is None:
            missing_evaluated.append(variant_id)
            continue
        field, raw_parameters = source
        parameters = bounded_policy_parameters(raw_parameters, parameter_space)
        if parameters is None:
            raise TrainingCardError(f"variant result {variant_id} has invalid evaluated policy parameters in {field}")
        evaluated.append(parameters)

    if evaluated:
        first = evaluated[0]
        if missing_evaluated:
            raise TrainingCardError(
                "policy update candidate has mixed evaluated parameter evidence for "
                f"{text_or_none(candidate.get('strategyVariantId')) or '<unknown>'}: "
                f"missing evaluated parameters for {', '.join(missing_evaluated)}"
            )
        if any(parameters != first for parameters in evaluated[1:]):
            raise TrainingCardError(
                "policy update candidate evaluated parameters disagree for "
                f"{text_or_none(candidate.get('strategyVariantId')) or '<unknown>'}"
            )
        if card_parameters is None:
            raise TrainingCardError(
                "policy_gradient candidate parameters are invalid for "
                f"{text_or_none(candidate.get('strategyVariantId')) or '<unknown>'}"
            )
        if card_parameters != first:
            raise TrainingCardError(
                "policy_gradient candidate parameters drift from evaluated parameters for "
                f"{text_or_none(candidate.get('strategyVariantId')) or '<unknown>'}"
            )
        return copy.deepcopy(first)

    return copy.deepcopy(card_parameters) if card_parameters is not None else None


def policy_update_return_samples(summaries: Sequence[JsonObject]) -> list[list[float | int]]:
    samples: list[list[float | int]] = []
    for summary in summaries:
        reward = summary.get("reward")
        raw_samples = reward.get("samples") if isinstance(reward, dict) else None
        added_summary_sample = False
        if isinstance(raw_samples, list):
            for raw_sample in raw_samples:
                sample = policy_return_tuple_from_sequence(raw_sample)
                if sample is not None:
                    samples.append(sample)
                    added_summary_sample = True
        if added_summary_sample:
            continue
        reward_tuple = policy_reward_tuple_values(summary)
        if reward_tuple is None:
            continue
        weight = policy_reward_tuple_sample_weight(summary)
        for _index in range(max(0, weight)):
            sample = policy_return_tuple_from_sequence(reward_tuple)
            if sample is not None:
                samples.append(sample)
    return samples


def policy_return_tuple_from_sequence(raw: Any) -> list[float | int] | None:
    if not isinstance(raw, list) or len(raw) < len(REWARD_TIERS):
        return None
    values: list[float | int] = []
    for value in raw[: len(REWARD_TIERS)]:
        if value is None:
            values.append(0)
            continue
        numeric = number_or_none(value)
        if numeric is None:
            return None
        values.append(round_policy_number(float(numeric)))
    return values


def policy_update_summary_parameter_source(summary: JsonObject) -> tuple[str, Any] | None:
    for field in ("evaluatedParameters", "evaluated_parameters", "parameters"):
        if field in summary:
            return field, summary.get(field)
    return None


def bounded_policy_parameters(raw: Any, parameter_space: dict[str, JsonObject]) -> JsonObject | None:
    if not isinstance(raw, dict):
        return None
    parameters: JsonObject = {}
    for name, spec in parameter_space.items():
        value = number_or_none(raw.get(name))
        if value is None:
            return None
        parameters[name] = bounded_policy_parameter_value(float(value), spec)
    return parameters


def aggregate_policy_reward_tuple(summaries: Sequence[JsonObject]) -> list[float | int]:
    weighted_sums = [0.0 for _tier in REWARD_TIERS]
    total_weight = 0
    for summary in summaries:
        reward_tuple = policy_reward_tuple_values(summary)
        if reward_tuple is None:
            continue
        weight = policy_reward_tuple_sample_weight(summary)
        total_weight += weight
        for index, value in enumerate(reward_tuple):
            weighted_sums[index] += float(value) * weight
    if total_weight == 0:
        return [0 for _tier in REWARD_TIERS]
    return [round_policy_number(value / total_weight) for value in weighted_sums]


def policy_reward_tuple_values(summary: JsonObject) -> list[Any] | None:
    reward = summary.get("reward")
    raw_tuple = reward.get("tuple") if isinstance(reward, dict) else None
    if not isinstance(raw_tuple, list) or len(raw_tuple) < len(REWARD_TIERS):
        return None
    return raw_tuple[: len(REWARD_TIERS)]


def policy_reward_tuple_sample_weight(summary: JsonObject) -> int:
    sample_count = int_or_none(summary.get("sampleCount"))
    if sample_count is None or sample_count < 0:
        return 1
    return sample_count


def policy_update_anchor_candidate(candidates: Sequence[JsonObject]) -> JsonObject | None:
    for row in candidates:
        if row.get("rolloutStatus") == "incumbent":
            return row
    return candidates[0] if candidates else None


def policy_update_reward_utilities(candidates: Sequence[JsonObject]) -> dict[str, float]:
    ordered_tuples: list[list[Any]] = []
    for row in sorted(
        candidates,
        key=lambda item: (*tuple(float(value) for value in item["rewardTuple"]), item["strategyVariantId"]),
        reverse=True,
    ):
        reward_tuple = row["rewardTuple"]
        if not any(compare_reward_tuples(reward_tuple, existing) == 0 for existing in ordered_tuples):
            ordered_tuples.append(reward_tuple)
    if len(ordered_tuples) <= 1:
        return {row["strategyVariantId"]: 0.0 for row in candidates}
    utilities: dict[str, float] = {}
    denominator = len(ordered_tuples) - 1
    for row in candidates:
        bucket_index = next(
            index
            for index, reward_tuple in enumerate(ordered_tuples)
            if compare_reward_tuples(row["rewardTuple"], reward_tuple) == 0
        )
        utilities[row["strategyVariantId"]] = (denominator - bucket_index) / denominator
    return utilities


def policy_update_learning_rate(policy_gradient: JsonObject) -> float:
    for key in ("policy_update", "policyUpdate", "update", "update_config", "updateConfig"):
        raw = policy_gradient.get(key)
        if not isinstance(raw, dict):
            continue
        value = number_or_none(raw.get("learning_rate", raw.get("learningRate")))
        if value is not None and 0 < float(value) <= 1:
            return float(value)
    return DEFAULT_POLICY_UPDATE_LEARNING_RATE


def bounded_policy_parameter_value(value: float, spec: JsonObject) -> float | int:
    minimum = float(spec["min"])
    maximum = float(spec["max"])
    bounded = max(minimum, min(maximum, value))
    step = number_or_none(spec.get("step"))
    if step is not None and float(step) > 0:
        step_float = float(step)
        bounded = minimum + (round((bounded - minimum) / step_float) * step_float)
        bounded = max(minimum, min(maximum, bounded))
    return round_policy_number(bounded)


def round_policy_number(value: float | int) -> float | int:
    numeric = float(value)
    rounded_int = round(numeric)
    if abs(numeric - rounded_int) < 1e-9:
        return int(rounded_int)
    return round(numeric, 6)


def policy_update_candidate_summary(row: JsonObject) -> JsonObject:
    return {
        "candidatePolicyId": row.get("candidatePolicyId"),
        "strategyVariantId": row.get("strategyVariantId"),
        "sourceStrategyId": row.get("sourceStrategyId"),
        "rolloutStatus": row.get("rolloutStatus"),
        "rewardTuple": row.get("rewardTuple"),
        "sampleCount": row.get("sampleCount"),
        "parameters": copy.deepcopy(row.get("parameters")),
        "resultVariantIds": copy.deepcopy(row.get("resultVariantIds")),
    }


def updated_candidate_policy_id(*, target_family: str, report_id: str, parameters: JsonObject) -> str:
    family_prefix = re.sub(r"[^A-Za-z0-9_.:-]+", "-", target_family).strip(".-:") or "policy"
    report_prefix = re.sub(r"[^A-Za-z0-9_.:-]+", "-", report_id).strip(".-:") or "report"
    digest = canonical_hash({"reportId": report_id, "parameters": parameters})[:12]
    return f"{family_prefix}.pg.updated.{report_prefix}.{digest}.v1"


def materialize_policy_update_artifacts(report: JsonObject, out_dir: Path) -> list[tuple[Path, JsonObject]]:
    update = report.get("policyUpdate")
    if not isinstance(update, dict) or int_or_none(update.get("iterations")) != 1:
        return []
    artifact = update.get("nextCandidatePolicy")
    if not isinstance(artifact, dict):
        return []
    report_id = text_or_none(report.get("reportId")) or "rl-training"
    safe_report_id = re.sub(r"[^A-Za-z0-9_.-]+", "-", report_id).strip(".-") or "rl-training"
    artifact_path = out_dir / POLICY_UPDATE_ARTIFACT_DIR / f"{safe_report_id}-next-policy.json"
    display_path = dataset_export.display_path(artifact_path)
    artifact["artifactPath"] = display_path
    update["artifactPath"] = display_path
    report["policyUpdateArtifactPath"] = display_path
    return [(artifact_path, artifact)]


def collect_variant_runs(
    simulator_runs: Sequence[JsonObject],
    expected_variant_ids: Sequence[str],
) -> dict[str, list[JsonObject]]:
    expected_variant_id_set = set(expected_variant_ids)
    collected: dict[str, list[JsonObject]] = {variant_id: [] for variant_id in expected_variant_ids}
    for run_index, run in enumerate(simulator_runs):
        emitted: dict[str, JsonObject] = {}
        if isinstance(run, dict):
            raw_variants = run.get("variants")
            if isinstance(raw_variants, list):
                run_label = simulator_run_label(run, run_index)
                for variant_index, raw_variant in enumerate(raw_variants):
                    if not isinstance(raw_variant, dict):
                        raise RuntimeError(
                            f"simulator run {run_label} emitted malformed variant row at "
                            f"variant_index={variant_index}: raw_variant={raw_variant!r}"
                        )
                    variant_id = raw_variant.get("variant_id", raw_variant.get("variantId"))
                    if not isinstance(variant_id, str) or not variant_id:
                        raise RuntimeError(
                            f"simulator run {run_label} emitted malformed variant row at "
                            f"variant_index={variant_index}: missing string variant id in raw_variant={raw_variant!r}"
                        )
                    if variant_id not in expected_variant_id_set:
                        raise RuntimeError(
                            f"simulator run {run_label} emitted unexpected variant id {variant_id!r}"
                        )
                    if variant_id in emitted:
                        raise RuntimeError(
                            f"simulator run {run_label} emitted duplicate variant id {variant_id!r}"
                        )
                    emitted[variant_id] = raw_variant
        for variant_id in expected_variant_ids:
            collected[variant_id].append(
                emitted.get(variant_id) or missing_variant_attempt(run, variant_id, run_index)
            )
    return collected


def simulator_run_label(run: JsonObject, run_index: int) -> str:
    run_id = run.get("runId")
    if isinstance(run_id, str) and run_id:
        return f"{run_id} (run_index={run_index})"
    return f"run[{run_index}]"


def missing_variant_attempt(run: Any, variant_id: str, run_index: int) -> JsonObject:
    run_id = (
        run.get("runId")
        if isinstance(run, dict) and isinstance(run.get("runId"), str)
        else f"run[{run_index}]"
    )
    return {
        "variant_id": variant_id,
        "variant_run_id": None,
        "ticks_run": None,
        "ok": False,
        "error": f"variant result missing from simulator run {run_id}",
    }


def summarize_variant(
    variant: StrategyVariant,
    runs: Sequence[JsonObject],
    reward_options: JsonObject,
) -> JsonObject:
    run_metrics_by_attempt: list[JsonObject | None] = []
    for run in runs:
        if run.get("ok") is True:
            run_metrics_by_attempt.append(compute_run_metrics(run, reward_options))
        else:
            run_metrics_by_attempt.append(None)
    run_metrics = [metrics for metrics in run_metrics_by_attempt if metrics is not None]
    excluded_run_count = len(runs) - len(run_metrics)
    reward_tuple = mean_reward_tuple(run_metrics)
    reward_tuple[0] = reliability_score(scored_run_count=len(run_metrics), total_run_count=len(runs))
    metrics = aggregate_metrics(run_metrics)
    metrics["reliability"]["score"] = reward_tuple[0]
    summary: JsonObject = {
        "variantId": variant.id,
        "family": variant.family,
        "rolloutStatus": variant.rollout_status,
        "sampleCount": len(run_metrics),
        "excludedRunCount": excluded_run_count,
        "ok": bool(run_metrics) and excluded_run_count == 0,
        "parameters": variant.parameters,
        "reward": {
            "type": "lexicographic",
            "componentOrder": list(REWARD_TIERS),
            "tuple": reward_tuple,
            "samples": reward_samples(run_metrics_by_attempt),
            "sampleStdDev": reward_sample_stddev(run_metrics_by_attempt),
        },
        "metrics": metrics,
        "runs": [
            {
                "variantRunId": run.get("variant_run_id", run.get("variantRunId")),
                "ticksRun": number_or_none(run.get("ticks_run", run.get("ticksRun"))),
                "ok": run.get("ok") is True,
                "error": text_or_none(run.get("error")),
            }
            for run in runs
        ],
    }
    if variant.candidate_policy_id:
        summary["candidatePolicyId"] = variant.candidate_policy_id
    if variant.source_strategy_id:
        summary["sourceStrategyId"] = variant.source_strategy_id
    if variant.parameter_evidence is not None:
        summary["parameterEvidence"] = copy.deepcopy(variant.parameter_evidence)
    if variant.training_role:
        summary["trainingRole"] = variant.training_role
    return summary


def compute_run_metrics(run: JsonObject, reward_options: JsonObject) -> JsonObject:
    explicit_metrics = run.get("metrics") if isinstance(run.get("metrics"), dict) else {}
    tick_log = run.get("tick_log", run.get("tickLog"))
    ticks = tick_log if isinstance(tick_log, list) else []
    initial_rooms = normalize_room_map(
        explicit_metrics.get(
            "initialRoomStates",
            explicit_metrics.get("initial_room_states", explicit_metrics.get("initialRooms", explicit_metrics.get("initial_rooms"))),
        )
    )
    final_rooms = normalize_room_map(
        explicit_metrics.get(
            "finalRoomStates",
            explicit_metrics.get("final_room_states", explicit_metrics.get("finalRooms", explicit_metrics.get("final_rooms"))),
        )
    )
    if ticks:
        if not initial_rooms:
            initial_rooms = rooms_from_tick(ticks[0])
        if not final_rooms:
            final_rooms = rooms_from_tick(ticks[-1])

    claimed_rooms = string_set(
        explicit_metrics.get(
            "claimedRooms",
            explicit_metrics.get("claimed_rooms", explicit_metrics.get("roomsClaimed", explicit_metrics.get("rooms_claimed"))),
        )
    )
    claimed_rooms.update(room for tick in ticks for room in rooms_from_tick(tick) if is_claimed_room(rooms_from_tick(tick)[room]))
    claimed_rooms.update(room for room, summary in initial_rooms.items() if is_claimed_room(summary))
    claimed_rooms.update(room for room, summary in final_rooms.items() if is_claimed_room(summary))

    initial_held = {
        room
        for room, summary in initial_rooms.items()
        if is_claimed_room(summary) or spawn_count(summary) > 0
    }
    survived_end = {
        room
        for room, summary in final_rooms.items()
        if room in claimed_rooms and room_survived(summary)
    }
    collapsed = claimed_rooms - survived_end
    initial_lost = initial_held - survived_end
    collapsed_expansion_loss = collapsed - initial_held
    rooms_gained = len(survived_end - initial_held)
    rooms_lost = len(initial_lost) + len(collapsed_expansion_loss)
    territory_delta = explicit_number(
        explicit_metrics,
        ("territoryDelta", "territory_delta"),
        default=rooms_gained - rooms_lost,
    )

    initial_energy = rooms_energy(initial_rooms)
    final_energy = rooms_energy(final_rooms)
    collected_energy = explicit_number(
        explicit_metrics,
        ("collectedEnergy", "collected_energy", "collectionDelta", "collection_delta"),
        default=sum(extract_collected_energy(tick) for tick in ticks),
    )
    stored_energy_delta = explicit_number(
        explicit_metrics,
        ("storedEnergyDelta", "stored_energy_delta", "energyStoredDelta", "energy_stored_delta"),
        default=final_energy - initial_energy,
    )
    resource_raw = stored_energy_delta + collected_energy
    resources_delta = explicit_number(
        explicit_metrics,
        ("resourceDelta", "resource_delta", "resourcesDelta", "resources_delta"),
        default=resource_raw / reward_options["resourceNormalizer"],
    )

    hostile_kills = explicit_number(
        explicit_metrics,
        ("hostileKills", "hostile_kills"),
        default=sum(extract_hostile_kills(tick) for tick in ticks),
    )
    own_losses = explicit_number(
        explicit_metrics,
        ("ownLosses", "own_losses"),
        default=sum(extract_own_losses(tick) for tick in ticks),
    )
    combat_delta = explicit_number(
        explicit_metrics,
        ("combatDelta", "combat_delta", "killsDelta", "kills_delta"),
        default=hostile_kills - own_losses,
    )

    reliability = 0 if run.get("ok") is False else 1
    initial_objective_signal = room_objective_signal(initial_rooms)
    final_objective_signal = room_objective_signal(final_rooms)
    reward_tuple = [
        reliability,
        round_float(territory_delta),
        round_float(resources_delta),
        round_float(combat_delta),
    ]
    return {
        "rewardTuple": reward_tuple,
        "reliability": {
            "score": reliability,
        },
        "territory": {
            "delta": round_float(territory_delta),
            "ownedRoomCount": len(survived_end),
            "roomsGained": rooms_gained,
            "roomsLost": rooms_lost,
            "roomGainLoss": {"gained": rooms_gained, "lost": rooms_lost},
            "initialHeldRooms": sorted(initial_held),
            "survivedEndRooms": sorted(survived_end),
            "claimedRooms": sorted(claimed_rooms),
            "collapsedClaimedRooms": sorted(collapsed),
            "rclLevels": {
                room: controller_level(summary)
                for room, summary in sorted(final_rooms.items())
                if room in claimed_rooms or room in survived_end
            },
            "rclDelta": round_float(rooms_rcl(final_rooms) - rooms_rcl(initial_rooms)),
        },
        "resources": {
            "delta": round_float(resources_delta),
            "raw": round_float(resource_raw),
            "storedEnergyDelta": round_float(stored_energy_delta),
            "collectedEnergy": round_float(collected_energy),
            "spawnUtilization": round_float(spawn_utilization(ticks)),
            "normalizer": reward_options["resourceNormalizer"],
        },
        "kills": {
            "delta": round_float(combat_delta),
            "hostileKills": round_float(hostile_kills),
            "ownLosses": round_float(own_losses),
        },
        "objectiveSignal": {
            "initialObservedRoomCount": len(initial_rooms),
            "finalObservedRoomCount": len(final_rooms),
            "initialRooms": sorted(initial_rooms),
            "finalRooms": sorted(final_rooms),
            "initialHostileCreeps": initial_objective_signal["hostileCreeps"],
            "finalHostileCreeps": final_objective_signal["hostileCreeps"],
            "initialHostileStructures": initial_objective_signal["hostileStructures"],
            "finalHostileStructures": final_objective_signal["hostileStructures"],
            "initialObjectiveSignalPresent": initial_objective_signal["objectiveSignalPresent"],
            "finalObjectiveSignalPresent": final_objective_signal["objectiveSignalPresent"],
        },
    }


def room_objective_signal(rooms: dict[str, JsonObject]) -> JsonObject:
    hostile_creeps = 0.0
    hostile_structures = 0.0
    for summary in rooms.values():
        combat = summary.get("combat")
        if isinstance(combat, dict):
            hostile_creeps += number_or_none(combat.get("hostileCreeps")) or 0.0
            hostile_structures += number_or_none(combat.get("hostileStructures")) or 0.0
    return {
        "hostileCreeps": round_float(hostile_creeps),
        "hostileStructures": round_float(hostile_structures),
        "objectiveSignalPresent": len(rooms) >= 2 and (hostile_creeps > 0 or hostile_structures > 0),
    }


def rooms_from_tick(tick: Any) -> dict[str, JsonObject]:
    if not isinstance(tick, dict):
        return {}
    for key in ("rooms", "roomStates", "room_states"):
        rooms = normalize_room_map(tick.get(key))
        if rooms:
            return rooms
    return {}


def normalize_room_map(raw: Any) -> dict[str, JsonObject]:
    rooms: dict[str, JsonObject] = {}
    if isinstance(raw, dict):
        for key, value in raw.items():
            if isinstance(value, dict):
                room_name = text_or_none(value.get("roomName")) or text_or_none(value.get("room")) or str(key)
                rooms[room_name] = value
        return rooms
    if isinstance(raw, list):
        for value in raw:
            if isinstance(value, dict):
                room_name = text_or_none(value.get("roomName")) or text_or_none(value.get("room"))
                if room_name:
                    rooms[room_name] = value
    return rooms


def is_claimed_room(summary: JsonObject) -> bool:
    if room_has_own_controller(summary):
        return True
    if spawn_count(summary) > 0 and controller_level(summary) > 0:
        return True
    return False


def room_survived(summary: JsonObject) -> bool:
    return spawn_count(summary) > 0 and creep_count(summary) > 0


def room_has_own_controller(summary: JsonObject) -> bool:
    if summary.get("claimed") is True or summary.get("owned") is True or summary.get("my") is True:
        return True
    controller = summary.get("controller")
    if isinstance(controller, dict):
        if controller.get("my") is True or controller.get("owned") is True:
            return True
        owner = controller.get("owner")
        if isinstance(owner, str) and owner in {"me", "self", "owned"}:
            return True
    return False


def spawn_count(summary: JsonObject) -> int:
    for key in ("owned_spawns", "ownedSpawnCount", "ownSpawnCount"):
        value = int_or_none(summary.get(key))
        if value is not None:
            return value
    structures = summary.get("ownStructureCounts")
    if isinstance(structures, dict):
        for key in ("spawn", "STRUCTURE_SPAWN"):
            value = int_or_none(structures.get(key))
            if value is not None:
                return value
    if not room_has_own_controller(summary):
        return 0
    for key in ("spawnCount", "spawns"):
        value = int_or_none(summary.get(key))
        if value is not None:
            return value
    structures = summary.get("structures")
    if isinstance(structures, dict):
        for key in ("spawn", "STRUCTURE_SPAWN"):
            value = int_or_none(structures.get(key))
            if value is not None:
                return value
    return 0


def creep_count(summary: JsonObject) -> int:
    for key in ("owned_creeps", "ownedCreeps", "ownedCreepCount"):
        value = int_or_none(summary.get(key))
        if value is not None:
            return value
    roles = summary.get("ownCreepRoles")
    if isinstance(roles, dict):
        role_total = sum(int_or_none(value) or 0 for value in roles.values())
        if role_total > 0:
            return role_total
    if not room_has_own_controller(summary):
        return 0
    for key in ("creeps", "workerCount"):
        value = int_or_none(summary.get(key))
        if value is not None:
            return value
    return 0


def controller_level(summary: JsonObject) -> int:
    controller = summary.get("controller")
    if isinstance(controller, dict):
        value = int_or_none(controller.get("level"))
        if value is not None:
            return value
    value = int_or_none(summary.get("rcl", summary.get("controllerLevel")))
    return value or 0


def rooms_rcl(rooms: dict[str, JsonObject]) -> float:
    return sum(controller_level(summary) for summary in rooms.values())


def rooms_energy(rooms: dict[str, JsonObject]) -> float:
    return sum(room_energy(summary) for summary in rooms.values())


def room_energy(summary: JsonObject) -> float:
    total = 0.0
    for key in ("storedEnergy", "stored_energy", "energy", "energyAvailable"):
        value = number_or_none(summary.get(key))
        if value is not None:
            total += value
            break
    resources = summary.get("resources")
    if isinstance(resources, dict):
        for key in ("storedEnergy", "workerCarriedEnergy", "droppedEnergy"):
            value = number_or_none(resources.get(key))
            if value is not None:
                total += value
    storage = summary.get("storage")
    if isinstance(storage, dict):
        store = storage.get("store")
        if isinstance(store, dict):
            total += float(number_or_none(store.get("energy")) or 0)
        else:
            total += float(number_or_none(storage.get("energy")) or 0)
    terminal = summary.get("terminal")
    if isinstance(terminal, dict):
        store = terminal.get("store")
        if isinstance(store, dict):
            total += float(number_or_none(store.get("energy")) or 0)
    return total


def extract_collected_energy(tick: Any) -> float:
    total = 0.0
    for room in rooms_from_tick(tick).values():
        resources = room.get("resources")
        if isinstance(resources, dict):
            events = resources.get("events")
            if isinstance(events, dict):
                for key in ("harvestedEnergy", "collectedEnergy", "pickupEnergy"):
                    total += float(number_or_none(events.get(key)) or 0)
        events = room.get("events")
        if isinstance(events, dict):
            for key in ("harvestedEnergy", "collectedEnergy", "pickupEnergy"):
                total += float(number_or_none(events.get(key)) or 0)
    return total


def extract_hostile_kills(tick: Any) -> float:
    total = 0.0
    for room in rooms_from_tick(tick).values():
        combat = room.get("combat")
        if isinstance(combat, dict):
            for key in ("hostileKills", "hostileCreepKills", "hostileStructureKills"):
                total += float(number_or_none(combat.get(key)) or 0)
            events = combat.get("events")
            if isinstance(events, dict):
                for key in ("hostileCreepDestroyedCount", "hostileStructureDestroyedCount", "objectDestroyedCount"):
                    total += float(number_or_none(events.get(key)) or 0)
    return total


def extract_own_losses(tick: Any) -> float:
    total = 0.0
    for room in rooms_from_tick(tick).values():
        combat = room.get("combat")
        if isinstance(combat, dict):
            for key in ("ownLosses", "ownCreepLosses", "ownStructureLosses"):
                total += float(number_or_none(combat.get(key)) or 0)
            events = combat.get("events")
            if isinstance(events, dict):
                for key in ("ownCreepDestroyedCount", "ownStructureDestroyedCount"):
                    total += float(number_or_none(events.get(key)) or 0)
    return total


def spawn_utilization(ticks: Sequence[Any]) -> float:
    busy = 0
    total = 0
    for tick in ticks:
        for room in rooms_from_tick(tick).values():
            status = room.get("spawnStatus")
            if isinstance(status, list):
                for item in status:
                    if not isinstance(item, dict):
                        continue
                    total += 1
                    item_status = str(item.get("status", "")).lower()
                    if item_status and item_status not in {"idle", "available"}:
                        busy += 1
            utilization = number_or_none(room.get("spawnUtilization"))
            if utilization is not None:
                return float(utilization)
    return busy / total if total > 0 else 0.0


def explicit_number(raw: JsonObject, keys: Sequence[str], *, default: float) -> float:
    for key in keys:
        value = number_or_none(raw.get(key))
        if value is not None:
            return float(value)
    return float(default)


def string_set(raw: Any) -> set[str]:
    if isinstance(raw, list):
        return {item for item in raw if isinstance(item, str) and item}
    if isinstance(raw, dict):
        return {str(key) for key, value in raw.items() if value}
    return set()


def int_or_none(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def number_or_none(value: Any) -> int | float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        return value
    return None


def round_float(value: float | int) -> float | int:
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return round(float(value), 6)


def mean_reward_tuple(metrics: Sequence[JsonObject]) -> list[float | int]:
    if not metrics:
        return [0 for _tier in REWARD_TIERS]
    columns = list(zip(*(metric["rewardTuple"] for metric in metrics)))
    return [round_float(statistics.fmean(float(value) for value in column)) for column in columns]


def reward_stddev(metrics: Sequence[JsonObject]) -> list[float | int]:
    if len(metrics) <= 1:
        return [0 for _tier in REWARD_TIERS]
    columns = list(zip(*(metric["rewardTuple"] for metric in metrics)))
    return [round_float(statistics.pstdev(float(value) for value in column)) for column in columns]


def reward_samples(metrics_by_attempt: Sequence[JsonObject | None]) -> list[list[Any]]:
    samples: list[list[Any]] = []
    for metrics in metrics_by_attempt:
        if metrics is None:
            samples.append([0, None, None, None])
        else:
            samples.append(list(metrics["rewardTuple"]))
    return samples


def reward_sample_stddev(metrics_by_attempt: Sequence[JsonObject | None]) -> list[float | int]:
    scored_metrics = [metrics for metrics in metrics_by_attempt if metrics is not None]
    sample_stddev = reward_stddev(scored_metrics)
    reliability_values = [1 if metrics is not None else 0 for metrics in metrics_by_attempt]
    sample_stddev[0] = component_stddev(reliability_values)
    return sample_stddev


def component_stddev(values: Sequence[float | int]) -> float | int:
    if len(values) <= 1:
        return 0
    return round_float(statistics.pstdev(float(value) for value in values))


def reliability_score(*, scored_run_count: int, total_run_count: int) -> float | int:
    if total_run_count <= 0:
        return 0
    return round_float(scored_run_count / total_run_count)


def aggregate_metrics(metrics: Sequence[JsonObject]) -> JsonObject:
    if not metrics:
        return {
            "reliability": empty_reliability_metrics(),
            "territory": empty_territory_metrics(),
            "resources": empty_resource_metrics(),
            "kills": empty_kill_metrics(),
            "objectiveSignal": empty_objective_signal_metrics(),
        }
    return {
        "reliability": {
            "score": mean_component(metrics, "reliability", "score"),
        },
        "territory": {
            "delta": mean_component(metrics, "territory", "delta"),
            "ownedRoomCount": mean_component(metrics, "territory", "ownedRoomCount"),
            "roomsGained": mean_component(metrics, "territory", "roomsGained"),
            "roomsLost": mean_component(metrics, "territory", "roomsLost"),
            "roomGainLoss": {
                "gained": mean_component(metrics, "territory", "roomsGained"),
                "lost": mean_component(metrics, "territory", "roomsLost"),
            },
            "rclDelta": mean_component(metrics, "territory", "rclDelta"),
            "rclLevels": aggregate_rcl_levels(metrics),
            "collapsedClaimedRooms": sorted(
                {
                    room
                    for metric in metrics
                    for room in metric["territory"].get("collapsedClaimedRooms", [])
                    if isinstance(room, str)
                }
            ),
            "survivedEndRooms": sorted(
                {
                    room
                    for metric in metrics
                    for room in metric["territory"].get("survivedEndRooms", [])
                    if isinstance(room, str)
                }
            ),
        },
        "resources": {
            "delta": mean_component(metrics, "resources", "delta"),
            "raw": mean_component(metrics, "resources", "raw"),
            "storedEnergyDelta": mean_component(metrics, "resources", "storedEnergyDelta"),
            "collectedEnergy": mean_component(metrics, "resources", "collectedEnergy"),
            "spawnUtilization": mean_component(metrics, "resources", "spawnUtilization"),
            "normalizer": metrics[0]["resources"]["normalizer"],
        },
        "kills": {
            "delta": mean_component(metrics, "kills", "delta"),
            "hostileKills": mean_component(metrics, "kills", "hostileKills"),
            "ownLosses": mean_component(metrics, "kills", "ownLosses"),
        },
        "objectiveSignal": {
            "initialObservedRoomCount": mean_component(metrics, "objectiveSignal", "initialObservedRoomCount"),
            "finalObservedRoomCount": mean_component(metrics, "objectiveSignal", "finalObservedRoomCount"),
            "initialHostileCreeps": mean_component(metrics, "objectiveSignal", "initialHostileCreeps"),
            "finalHostileCreeps": mean_component(metrics, "objectiveSignal", "finalHostileCreeps"),
            "initialHostileStructures": mean_component(metrics, "objectiveSignal", "initialHostileStructures"),
            "finalHostileStructures": mean_component(metrics, "objectiveSignal", "finalHostileStructures"),
            "initialObjectiveSignalPresent": any(
                metric["objectiveSignal"].get("initialObjectiveSignalPresent") is True
                for metric in metrics
            ),
            "finalObjectiveSignalPresent": any(
                metric["objectiveSignal"].get("finalObjectiveSignalPresent") is True
                for metric in metrics
            ),
            "initialRooms": sorted(
                {
                    room
                    for metric in metrics
                    for room in metric["objectiveSignal"].get("initialRooms", [])
                    if isinstance(room, str)
                }
            ),
            "finalRooms": sorted(
                {
                    room
                    for metric in metrics
                    for room in metric["objectiveSignal"].get("finalRooms", [])
                    if isinstance(room, str)
                }
            ),
        },
    }


def empty_reliability_metrics() -> JsonObject:
    return {"score": 0}


def empty_territory_metrics() -> JsonObject:
    return {
        "delta": 0,
        "ownedRoomCount": 0,
        "roomsGained": 0,
        "roomsLost": 0,
        "roomGainLoss": {"gained": 0, "lost": 0},
        "rclDelta": 0,
        "rclLevels": {},
        "collapsedClaimedRooms": [],
        "survivedEndRooms": [],
    }


def empty_resource_metrics() -> JsonObject:
    return {
        "delta": 0,
        "raw": 0,
        "storedEnergyDelta": 0,
        "collectedEnergy": 0,
        "spawnUtilization": 0,
        "normalizer": DEFAULT_RESOURCE_NORMALIZER,
    }


def empty_kill_metrics() -> JsonObject:
    return {"delta": 0, "hostileKills": 0, "ownLosses": 0}


def empty_objective_signal_metrics() -> JsonObject:
    return {
        "initialObservedRoomCount": 0,
        "finalObservedRoomCount": 0,
        "initialRooms": [],
        "finalRooms": [],
        "initialHostileCreeps": 0,
        "finalHostileCreeps": 0,
        "initialHostileStructures": 0,
        "finalHostileStructures": 0,
        "initialObjectiveSignalPresent": False,
        "finalObjectiveSignalPresent": False,
    }


def mean_component(metrics: Sequence[JsonObject], component: str, field: str) -> float | int:
    values = [float(metric[component].get(field, 0)) for metric in metrics]
    return round_float(statistics.fmean(values)) if values else 0


def aggregate_rcl_levels(metrics: Sequence[JsonObject]) -> JsonObject:
    levels_by_room: dict[str, list[float]] = {}
    for metric in metrics:
        levels = metric["territory"].get("rclLevels")
        if not isinstance(levels, dict):
            continue
        for room, level in levels.items():
            numeric = number_or_none(level)
            if isinstance(room, str) and numeric is not None:
                levels_by_room.setdefault(room, []).append(float(numeric))
    return {
        room: round_float(statistics.fmean(values))
        for room, values in sorted(levels_by_room.items())
    }


def rank_variant_results(results: Sequence[JsonObject]) -> list[JsonObject]:
    sorted_results = sorted(
        results,
        key=lambda item: (*tuple(float(value) for value in item["reward"]["tuple"]), item["variantId"]),
        reverse=True,
    )
    ranking: list[JsonObject] = []
    previous_tuple: list[Any] | None = None
    previous_rank = 0
    for index, result in enumerate(sorted_results):
        reward_tuple = list(result["reward"]["tuple"])
        rank = previous_rank if reward_tuple == previous_tuple else index + 1
        previous_tuple = reward_tuple
        previous_rank = rank
        ranking.append(
            {
                "rank": rank,
                "variantId": result["variantId"],
                "rewardTuple": reward_tuple,
                "sampleCount": result["sampleCount"],
                "ok": result["ok"],
            }
        )
    return ranking


def build_pairwise_comparisons(results: Sequence[JsonObject]) -> list[JsonObject]:
    comparisons: list[JsonObject] = []
    for left_index, left in enumerate(results):
        for right in results[left_index + 1 :]:
            comparison = compare_reward_tuples(left["reward"]["tuple"], right["reward"]["tuple"])
            if comparison > 0:
                winner = left["variantId"]
            elif comparison < 0:
                winner = right["variantId"]
            else:
                winner = None
            comparisons.append(
                {
                    "left": left["variantId"],
                    "right": right["variantId"],
                    "winner": winner,
                    "firstDifferingTier": first_differing_tier(left["reward"]["tuple"], right["reward"]["tuple"]),
                    "delta": {
                        tier: round_float(float(left["reward"]["tuple"][index]) - float(right["reward"]["tuple"][index]))
                        for index, tier in enumerate(REWARD_TIERS)
                    },
                }
            )
    return comparisons


def best_incumbent_reward_tuple_from_ranking(
    ranking: Sequence[JsonObject], incumbent_ids: Sequence[str]
) -> Sequence[Any] | None:
    best_tuple: Sequence[Any] | None = None
    for item in ranking:
        if item["variantId"] not in incumbent_ids:
            continue
        reward_tuple = item["rewardTuple"]
        if best_tuple is None or compare_reward_tuples(reward_tuple, best_tuple) > 0:
            best_tuple = reward_tuple
    return best_tuple


def variant_strictly_beats_best_incumbent(
    item: JsonObject, incumbent_ids: Sequence[str], best_incumbent_reward_tuple: Sequence[Any] | None
) -> bool:
    if item["variantId"] in incumbent_ids or best_incumbent_reward_tuple is None:
        return False
    return compare_reward_tuples(item["rewardTuple"], best_incumbent_reward_tuple) > 0


def compare_reward_tuples(left: Sequence[Any], right: Sequence[Any]) -> int:
    for left_value, right_value in zip(left, right):
        left_float = float(left_value)
        right_float = float(right_value)
        if left_float > right_float:
            return 1
        if left_float < right_float:
            return -1
    return 0


def first_differing_tier(left: Sequence[Any], right: Sequence[Any]) -> str | None:
    for index, tier in enumerate(REWARD_TIERS):
        if index >= len(left) or index >= len(right):
            return tier
        if float(left[index]) != float(right[index]):
            return tier
    return None


def incumbent_strategy_ids(variants: Sequence[StrategyVariant]) -> list[str]:
    incumbents = [variant.id for variant in variants if variant.rollout_status == "incumbent"]
    return incumbents or ([variants[0].id] if variants else [])


def build_shadow_compatible_model_reports(
    ranking: Sequence[JsonObject],
    incumbent_ids: Sequence[str],
    best_incumbent_reward_tuple: Sequence[Any] | None = None,
) -> list[JsonObject]:
    incumbent = incumbent_ids[0] if incumbent_ids else None
    if best_incumbent_reward_tuple is None:
        best_incumbent_reward_tuple = best_incumbent_reward_tuple_from_ranking(ranking, incumbent_ids)
    reports: list[JsonObject] = []
    rank_by_variant = {item["variantId"]: item["rank"] for item in ranking}
    incumbent_rank = rank_by_variant.get(incumbent) if incumbent else None
    for item in ranking:
        variant_id = item["variantId"]
        if variant_id == incumbent:
            continue
        changed_top = item["rank"] == 1 and variant_strictly_beats_best_incumbent(
            item, incumbent_ids, best_incumbent_reward_tuple
        )
        reports.append(
            {
                "family": "rl-training",
                "incumbentStrategyId": incumbent,
                "candidateStrategyId": variant_id,
                "rankingDiffCount": 1 if incumbent_rank is not None and item["rank"] != incumbent_rank else 0,
                "changedTopCount": 1 if changed_top else 0,
                "rankingDiffsTruncated": False,
                "rankingDiffs": [
                    {
                        "artifactIndex": 0,
                        "context": "rl-training-lexicographic-reward",
                        "changedTop": changed_top,
                        "incumbentTop": {
                            "itemId": incumbent,
                            "rank": incumbent_rank,
                            "score": None,
                        }
                        if incumbent
                        else None,
                        "candidateTop": {
                            "itemId": variant_id,
                            "rank": item["rank"],
                            "score": None,
                        },
                        "rankChangeCount": 1,
                        "rankChangeSamples": [
                            {
                                "itemId": variant_id,
                                "incumbentRank": incumbent_rank,
                                "candidateRank": item["rank"],
                                "delta": None,
                            }
                        ],
                    }
                ],
            }
        )
    return reports


def build_kpi_summary(results: Sequence[JsonObject]) -> JsonObject:
    if not results:
        return {}
    best = rank_variant_results(results)[0]
    reward_index = {tier: index for index, tier in enumerate(REWARD_TIERS)}
    return {
        "reliability": {
            "score": best["rewardTuple"][reward_index["reliability"]],
            "components": {
                result["variantId"]: result["metrics"]["reliability"]["score"]
                for result in results
            },
        },
        "territory": {
            "score": best["rewardTuple"][reward_index["territory"]],
            "components": {
                result["variantId"]: result["metrics"]["territory"]["delta"]
                for result in results
            },
        },
        "resources": {
            "score": best["rewardTuple"][reward_index["resources"]],
            "components": {
                result["variantId"]: result["metrics"]["resources"]["delta"]
                for result in results
            },
        },
        "kills": {
            "score": best["rewardTuple"][reward_index["kills"]],
            "components": {
                result["variantId"]: result["metrics"]["kills"]["delta"]
                for result in results
            },
        },
    }


def build_multi_tier_activation_proof(
    *,
    results: Sequence[JsonObject],
    scenario: JsonObject | None,
    kpi_summary: JsonObject,
) -> JsonObject | None:
    if not scenario_supports_multi_tier_policy_comparison(scenario):
        return None
    rows = [multi_tier_activation_variant_row(result) for result in results]
    passed_rows = [row for row in rows if row["passesActivation"]]
    transport_observed = any(row["objectiveSignalObserved"] for row in rows)
    status = "passed" if passed_rows else "blocked"
    proof: JsonObject = {
        "type": MULTI_TIER_ACTIVATION_PROOF_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "status": status,
        "ok": status == "passed",
        "scenarioId": scenario.get("scenario_id", scenario.get("scenarioId")) if isinstance(scenario, dict) else None,
        "criteria": {
            "operator": "and",
            "objectiveSignalMustBeObserved": True,
            "activationScoreOperator": "or",
            "territoryScoreMustExceed": MULTI_TIER_TERRITORY_ACTIVATION_THRESHOLD,
            "hostileKillsMustExceed": MULTI_TIER_HOSTILE_KILLS_ACTIVATION_THRESHOLD,
            "requiredForPaidTencentValidation": True,
        },
        "fixtureEvidence": multi_tier_fixture_evidence(scenario),
        "transport": {
            "objectiveSignalObserved": transport_observed,
            "classification": "observed_in_variant_metrics" if transport_observed else "not_observed_in_variant_metrics",
        },
        "bestObserved": {
            "territoryScore": max((float(row["territoryScore"]) for row in rows), default=0.0),
            "hostileKills": max((float(row["hostileKills"]) for row in rows), default=0.0),
            "kpiSummary": copy.deepcopy(kpi_summary),
        },
        "variants": rows,
    }
    if passed_rows:
        proof["passingVariants"] = [row["variantId"] for row in passed_rows]
    else:
        classification = (
            "SIMULATOR_OBJECTIVE_SIGNAL_NOT_ACTIVATED"
            if transport_observed
            else "SIMULATOR_FIXTURE_SIGNAL_NOT_TRANSPORTED"
        )
        proof["blocker"] = {
            "classification": classification,
            "criticality": "P0",
            "evidence": (
                "multi-tier fixture signal reached variant metrics, but no variant exceeded territory score "
                f"{MULTI_TIER_TERRITORY_ACTIVATION_THRESHOLD} or hostile kills "
                f"{MULTI_TIER_HOSTILE_KILLS_ACTIVATION_THRESHOLD}"
                if transport_observed
                else "multi-tier card fixture evidence did not reach variant objective metrics"
            ),
            "action": "repair local/private simulator objective activation before paid Tencent validation",
        }
    return proof


def multi_tier_activation_variant_row(result: JsonObject) -> JsonObject:
    metrics = result.get("metrics") if isinstance(result.get("metrics"), dict) else {}
    territory = metrics.get("territory") if isinstance(metrics.get("territory"), dict) else {}
    kills = metrics.get("kills") if isinstance(metrics.get("kills"), dict) else {}
    objective = metrics.get("objectiveSignal") if isinstance(metrics.get("objectiveSignal"), dict) else {}
    territory_score = number_or_none(territory.get("delta")) or 0
    hostile_kills = number_or_none(kills.get("hostileKills")) or 0
    observed = (
        objective_phase_signal_observed(objective, "initial")
        or objective_phase_signal_observed(objective, "final")
    )
    activation_score_passes = (
        float(territory_score) > MULTI_TIER_TERRITORY_ACTIVATION_THRESHOLD
        or float(hostile_kills) > MULTI_TIER_HOSTILE_KILLS_ACTIVATION_THRESHOLD
    )
    passes = observed and activation_score_passes
    return {
        "variantId": result.get("variantId"),
        "sampleCount": result.get("sampleCount", 0),
        "territoryScore": round_float(territory_score),
        "hostileKills": round_float(hostile_kills),
        "objectiveSignalObserved": observed,
        "passesActivation": passes,
        "objectiveSignal": copy.deepcopy(objective),
    }


def objective_phase_signal_observed(objective: JsonObject, phase: str) -> bool:
    if objective.get(f"{phase}ObjectiveSignalPresent") is True:
        return True
    observed_rooms = number_or_none(objective.get(f"{phase}ObservedRoomCount")) or 0
    hostile_creeps = number_or_none(objective.get(f"{phase}HostileCreeps")) or 0
    hostile_structures = number_or_none(objective.get(f"{phase}HostileStructures")) or 0
    return observed_rooms >= 2 and (hostile_creeps > 0 or hostile_structures > 0)


def multi_tier_fixture_evidence(scenario: JsonObject | None) -> JsonObject:
    evidence = scenario.get("evidence") if isinstance(scenario, dict) and isinstance(scenario.get("evidence"), dict) else {}
    return {
        "roomCount": evidence.get("room_count", evidence.get("roomCount")),
        "anchorRoom": evidence.get("anchor_room", evidence.get("anchorRoom")),
        "adjacentRoom": evidence.get("adjacent_room", evidence.get("adjacentRoom")),
        "adjacentRooms": copy.deepcopy(evidence.get("adjacent_rooms", evidence.get("adjacentRooms"))),
        "hostileCreepCount": evidence.get("hostile_creep_count", evidence.get("hostileCreepCount")),
        "hostileStructureCount": evidence.get("hostile_structure_count", evidence.get("hostileStructureCount")),
        "hostileSpawnCount": evidence.get("hostile_spawn_count", evidence.get("hostileSpawnCount")),
        "mapSourceFile": evidence.get("map_source_file", evidence.get("mapSourceFile")),
        "implementationStatus": evidence.get("implementation_status", evidence.get("implementationStatus")),
    }


def build_report_warnings(results: Sequence[JsonObject], simulator_runs: Sequence[JsonObject]) -> list[str]:
    warnings: list[str] = []
    for result in results:
        excluded_run_count = int(result.get("excludedRunCount", 0))
        if excluded_run_count > 0:
            warnings.append(
                f"variant {result['variantId']} excluded {excluded_run_count} failed simulator run(s) "
                "from sampleCount and non-reliability reward tiers; reliability scored them as 0"
            )
        elif result["sampleCount"] == 0:
            warnings.append(f"variant {result['variantId']} produced no simulator result")
        elif not result["ok"]:
            warnings.append(f"variant {result['variantId']} had simulator errors")
    for run in simulator_runs:
        if isinstance(run, dict) and run.get("liveEffect") is True:
            warnings.append("simulator run unexpectedly reported liveEffect=true")
        if isinstance(run, dict) and run.get("officialMmoWrites") is True:
            warnings.append("simulator run unexpectedly reported officialMmoWrites=true")
    return warnings[:20]


def summarize_card(card: JsonObject, path: Path) -> JsonObject:
    summary = {
        "path": dataset_export.display_path(path),
        "cardId": card.get("card_id", card.get("cardId")),
        "datasetRunId": card.get("dataset_run_id", card.get("datasetRunId")),
        "codeCommit": card.get("code_commit", card.get("codeCommit")),
        "trainingApproach": card.get("training_approach", card.get("trainingApproach")),
        "status": card.get("status", "shadow"),
        "safety": card.get("safety"),
    }
    policy_gradient = policy_gradient_metadata_from_card(card)
    if policy_gradient is not None:
        summary["policyGradient"] = policy_gradient
    card_supply = card.get("card_supply", card.get("cardSupply"))
    if isinstance(card_supply, dict):
        summary["cardSupply"] = copy.deepcopy(card_supply)
    scenario = scenario_metadata_from_card(card)
    if scenario is not None:
        summary["scenario"] = scenario
        summary["multiTierPolicyComparisonSuitable"] = scenario_supports_multi_tier_policy_comparison(scenario)
    return summary


def scenario_metadata_from_card(card: JsonObject) -> JsonObject | None:
    raw = card.get("scenario", card.get("trainingScenario"))
    if not isinstance(raw, dict):
        return None
    return copy.deepcopy(raw)


def policy_gradient_metadata_from_card(card: JsonObject) -> JsonObject | None:
    raw = card.get("policy_gradient", card.get("policyGradient"))
    if not isinstance(raw, dict):
        return None
    return copy.deepcopy(raw)


def safety_metadata() -> JsonObject:
    return {
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "conservative_actions_only": True,
        "ood_rejection": True,
        "officialMmoControl": False,
        "inputMode": "experiment card plus local private-server simulator harness output",
        "simulatorOnly": True,
        "liveApiCalls": False,
        "liveSecretsRequired": False,
        "memoryWritesAllowed": False,
        "rawMemoryWritesAllowed": False,
        "rawCreepIntentControl": False,
        "spawnIntentControl": False,
        "constructionIntentControl": False,
        "marketIntentControl": False,
        "allowedUse": "offline/private simulator analysis and shadow reports only",
    }


def default_report_id(card: JsonObject, variants: Sequence[StrategyVariant], config: SimulationConfig) -> str:
    seed = {
        "card": summarize_card(card, Path("<card>")),
        "variants": [variant.to_json() for variant in variants],
        "simulation": config.to_json(),
    }
    card_id = text_or_none(card.get("card_id", card.get("cardId"))) or "rl-training"
    safe_card_id = re.sub(r"[^A-Za-z0-9_.-]", "-", card_id).strip(".-") or "rl-training"
    return f"{safe_card_id}-{canonical_hash(seed)[:12]}"


def validate_report_id(report_id: str) -> None:
    if not REPORT_ID_RE.fullmatch(report_id) or report_id in {".", ".."}:
        raise TrainingCardError("report id may contain only letters, numbers, dot, underscore, and hyphen")


def assert_no_secret_leak(payload: JsonObject, secrets: Sequence[str]) -> None:
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=True)
    for secret in secrets:
        if secret and len(secret) >= 6 and secret in encoded:
            raise RuntimeError("refusing to persist RL training report containing a configured secret")


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(temp_fd, "w", encoding="utf-8") as handle:
            temp_fd = -1
            handle.write(canonical_json(payload))
        os.replace(temp_path, path)
    finally:
        if temp_fd != -1:
            try:
                os.close(temp_fd)
            except OSError:
                pass
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


def build_generation_summary(report: JsonObject) -> JsonObject:
    summary = {
        "ok": True,
        "type": SUMMARY_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "reportId": report["reportId"],
        "reportPath": report.get("reportPath"),
        "liveEffect": False,
        "officialMmoWrites": False,
        "candidateStrategyIds": report["candidateStrategyIds"],
        "incumbentStrategyIds": report["incumbentStrategyIds"],
        "topVariantId": report["ranking"][0]["variantId"] if report["ranking"] else None,
        "artifactCount": report["artifactCount"],
        "changedTopCount": report["changedTopCount"],
        "policyUpdateIterations": report.get("policyUpdateIterations", 0),
        "policyUpdateAlgorithm": report.get("policyUpdateAlgorithm"),
        "policyUpdateCandidatePolicyId": report.get("policyUpdateCandidatePolicyId"),
        "policyUpdateArtifactPath": report.get("policyUpdateArtifactPath"),
        "trueGradient": report.get("trueGradient", False),
        "warnings": report["warnings"],
    }
    if "scaleValidation" in report:
        summary["scaleValidation"] = report["scaleValidation"]
    if "activationProof" in report:
        proof = report["activationProof"]
        summary["activationProof"] = {
            "status": proof.get("status"),
            "ok": proof.get("ok"),
            "blocker": copy.deepcopy(proof.get("blocker")) if isinstance(proof.get("blocker"), dict) else None,
            "passingVariants": copy.deepcopy(proof.get("passingVariants", [])),
            "bestObserved": copy.deepcopy(proof.get("bestObserved", {})),
        }
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run offline Screeps RL strategy experiments through the private simulator harness.",
    )
    parser.add_argument("--experiment-card", required=True, type=Path, help="Experiment card JSON/YAML path.")
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_OUT_DIR,
        help=f"Training report output directory. Default: {DEFAULT_OUT_DIR}.",
    )
    parser.add_argument("--report-id", help="Optional report file stem. Defaults to card/config hash.")
    parser.add_argument(
        "--registry-path",
        type=Path,
        default=simulator_harness.DEFAULT_STRATEGY_REGISTRY_PATH,
        help="Strategy registry TypeScript source. Inline variant parameters still work if this is missing.",
    )
    parser.add_argument(
        "--steam-key-env-file",
        type=Path,
        default=None,
        help=(
            "Optional env file to load STEAM_KEY from when it is absent. "
            f"Defaults to {DEFAULT_STEAM_KEY_ENV_FILE} for real simulator runs; "
            f"env override: {STEAM_KEY_ENV_FILE_ENV}."
        ),
    )
    parser.add_argument(
        "--print-report",
        action="store_true",
        help="Print the full report instead of the compact generation summary.",
    )
    return parser


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    args = build_parser().parse_args(argv)
    try:
        report = run_training_experiment(
            args.experiment_card,
            args.out_dir,
            report_id=args.report_id,
            registry_path=args.registry_path,
            steam_key_env_file=args.steam_key_env_file,
        )
        stdout.write(canonical_json(report if args.print_report else build_generation_summary(report)))
        return 0
    except (RuntimeError, TrainingCardError, OSError) as error:
        stderr.write(f"error: {dataset_export.redact_text(str(error))}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
