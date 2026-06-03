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
from typing import Any, Callable, Mapping, Sequence, TextIO

from screeps_rl_experiment_card import (
    POLICY_GRADIENT_MIN_SIMULATION_TICKS,
    policy_gradient_trust_sample_plan,
    scenario_supports_multi_tier_policy_comparison,
    validate_scenario_metadata,
)
import screeps_rl_dataset_export as dataset_export
import screeps_secret_env
import screeps_rl_simulator_harness as simulator_harness
import screeps_rl_scale_gates as scale_gates
import screeps_rl_scorecard as scorecard_helper
import screeps_rl_role_policy_lanes as role_policy_lanes


SCHEMA_VERSION = 1
REPORT_TYPE = "screeps-rl-training-report"
SUMMARY_TYPE = "screeps-rl-training-generation"
DEFAULT_OUT_DIR = Path("runtime-artifacts/rl-training")
DEFAULT_RESOURCE_NORMALIZER = 1000.0
DEFAULT_RUN_REPETITIONS = 1
DEFAULT_STEAM_KEY_ENV_FILE = screeps_secret_env.DEFAULT_LOCAL_SECRET_ENV_FILE
STEAM_KEY_ENV_FILE_ENV = "SCREEPS_RL_STEAM_KEY_ENV_FILE"
PRE_SCALE_TRAINABILITY_SMOKE_TICKS = 2
DEFAULT_POLICY_UPDATE_LEARNING_RATE = 0.25
RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM = "rank_weighted_finite_difference_v1"
TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM = "reinforce_v1"
POLICY_UPDATE_ALGORITHM = RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM
DEFAULT_POLICY_UPDATE_ALGORITHM = TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM
METADATA_ONLY_POLICY_UPDATE_SKIP_REASON = "candidate_parameters_metadata_only"
RUNTIME_PARAMETER_INJECTION_INCOMPLETE_SKIP_REASON = "runtime_parameter_injection_missing_or_incomplete"
SIMULATOR_SETUP_PLACE_SPAWN_ROOM_BUSY_SKIP_REASON = "simulator_setup_place_spawn_room_busy"
POLICY_UPDATE_ARTIFACT_DIR = "policy-candidates"
CANDIDATE_SCORECARD_ARTIFACT_DIR = "candidate-scorecards"
MULTI_CANDIDATE_SCORECARD_SET_TYPE = "screeps-rl-multi-candidate-scorecard-set"
POLICY_UPDATE_PROMOTION_GATE_TYPE = "screeps-rl-policy-update-promotion-gate"
GRADIENT_STABILITY_GATE_TYPE = "screeps-rl-gradient-stability-gate"
POLICY_UPDATE_CONSUMPTION_MODE_RUNTIME_CONSUMED = "runtime_consumed"
POLICY_UPDATE_CONSUMPTION_MODE_SCORECARD_NON_CONSUMED = (
    "runtime_injected_scorecard_metadata_non_promotional"
)
POLICY_UPDATE_CONSUMPTION_MODE_METADATA_ONLY = "metadata_only_non_promotional"
POLICY_UPDATE_CONSUMPTION_MODE_INCOMPLETE = "runtime_parameter_evidence_incomplete_non_promotional"
RUNTIME_PARAMETER_TRANSPORT_WITHOUT_CONSUMPTION_STATUSES = {
    "missing",
    "missing_runtime_parameter_consumption",
    "missing_evaluated_parameters",
    "invalid_evaluated_parameters",
}
RUNTIME_PARAMETER_CONSUMPTION_BLOCKER_STATUSES = {
    "missing",
    "mixed",
    *RUNTIME_PARAMETER_TRANSPORT_WITHOUT_CONSUMPTION_STATUSES,
}
DEFAULT_GRADIENT_TRUST_MIN_SAMPLES_PER_CANDIDATE = 20
DEFAULT_GRADIENT_DIRECTION_CONSISTENCY_THRESHOLD = 0.8
DEFAULT_GRADIENT_EMA_DECAY = 0.8
GRADIENT_ESTIMATION_EVIDENCE_TYPE = "screeps-rl-gradient-estimation-evidence"
GRADIENT_ESTIMATION_SCHEME_TYPE = "screeps-rl-gradient-estimation-scheme"
GRADIENT_MOMENTUM_EVIDENCE_TYPE = "screeps-rl-gradient-momentum-evidence"
GRADIENT_MOMENTUM_STATE_TYPE = "screeps-rl-gradient-momentum-state"
GRADIENT_MOMENTUM_STATE_IDENTITY_TYPE = "screeps-rl-gradient-momentum-state-identity"
GRADIENT_MOMENTUM_STATE_ARTIFACT_DIR = "gradient-momentum"
POLICY_GRADIENT_SCALAR_ESTIMATOR = "scalar_weighted_sum_score_function_reinforce_v1"
POLICY_GRADIENT_SCALAR_REWARD = "scalar_weighted_sum"
POLICY_GRADIENT_SCALAR_WEIGHTED_SUM_USE = "gradient_estimation_only_non_promotional"
SCALAR_WEIGHTED_SUM_AUTHORIZED_USE = "offline_private_shadow_policy_gradient_comparison"
POLICY_GRADIENT_LEXICOGRAPHIC_REINFORCE_ESTIMATOR = "lexicographic_per_tier_score_function_reinforce_v1"
POLICY_GRADIENT_LEXICOGRAPHIC_PER_TIER_REWARD = "lexicographic_per_tier"
POLICY_GRADIENT_LEXICOGRAPHIC_TIER_BASELINE = "anchor_candidate_mean_return"
POLICY_GRADIENT_LEXICOGRAPHIC_TIER_SELECTION = "first_nonzero_reward_tier_by_parameter"
POLICY_GRADIENT_LEXICOGRAPHIC_PAIRWISE_ADVANTAGE_SCALE = 0.5
POLICY_GRADIENT_LEXICOGRAPHIC_REWARD = "lexicographic"
# Cap the estimator reward scale used by the update gradient; promotion remains
# lexicographic-gated.
DEFAULT_POLICY_GRADIENT_SCALAR_WEIGHT_NORMALIZATION_CAP = 10_000.0
DEFAULT_POLICY_GRADIENT_SCALAR_COMPONENT_WEIGHTS = {
    "reliability": 1000000000.0,
    "territory": 1000000.0,
    "resources": 1000.0,
    "kills": 1.0,
}
REWARD_TIERS = ("reliability", "territory", "resources", "kills")
SCALAR_WEIGHTED_REWARD_TIERS = (*REWARD_TIERS, "activation")
MULTI_TIER_ACTIVATION_PROOF_TYPE = "screeps-rl-multi-tier-activation-proof"
MULTI_TIER_ACTIVATION_AUDIT_TYPE = "screeps-rl-multi-tier-activation-audit"
MULTI_TIER_ACTIVATION_IMPLEMENTATION = "multi-tier-policy-activation-proof-v2"
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
ISO_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$")
JsonObject = dict[str, Any]
SimulatorRunner = Callable[..., JsonObject]
MultiTierPolicyActivationFixtureLoader = Callable[[], tuple[dict[str, JsonObject], str | None]]
REPO_ROOT = Path(__file__).resolve().parents[1]


class TrainingCardError(ValueError):
    """Raised when an experiment card is unsafe or structurally invalid."""


@dataclass(frozen=True)
class StrategyVariant:
    """Strategy candidate metadata consumed by the simulator and report."""

    id: str
    parameters: JsonObject
    candidate_policy_id: str | None = None
    family: str | None = None
    policy_family: str | None = None
    role_policy: str | None = None
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
        if self.policy_family:
            payload["policyFamily"] = self.policy_family
        if self.role_policy:
            payload["rolePolicy"] = self.role_policy
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


def runtime_parameter_parameters_hash(parameters: JsonObject) -> str:
    return simulator_harness.runtime_parameter_parameters_hash(parameters)


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
    training_approach = card.get("training_approach", card.get("trainingApproach"))

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
    if scalar_authorized is True:
        validate_scalar_weighted_reward_authorization(card, reward_model, training_approach)
    elif scalar_authorized is not False:
        raise TrainingCardError("reward_model.scalar_weighted_sum_authorized must be false unless explicitly authorized")

    validate_card_supply(card)
    validate_role_policy_lane_contract(card)
    validate_scenario_metadata(card, error_cls=TrainingCardError, require_presence=True)

    raw_variants = raw_variant_definitions(card)
    if not isinstance(raw_variants, list) or len(raw_variants) == 0:
        raise TrainingCardError("experiment card must define at least one strategy variant")
    try:
        role_policy_lanes.validate_role_policy_collection(
            [item for item in raw_variants if isinstance(item, dict)],
            context="strategy_variants",
            parent=card,
        )
    except role_policy_lanes.RolePolicyLaneError as error:
        raise TrainingCardError(str(error)) from error

    simulation = raw_mapping(card.get("simulation", card.get("simulator", {})), "simulation")
    ticks = positive_int_value(simulation["ticks"]) if "ticks" in simulation else None
    if "ticks" in simulation and ticks is None:
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
    if training_approach == "policy_gradient" and (ticks is None or ticks < POLICY_GRADIENT_MIN_SIMULATION_TICKS):
        raise TrainingCardError(
            f"policy_gradient cards require simulation.ticks >= {POLICY_GRADIENT_MIN_SIMULATION_TICKS}"
        )
    if training_approach == "policy_gradient":
        validate_policy_gradient_scale_sample_plan(card, simulation, raw_variants)


def validate_scalar_weighted_reward_authorization(
    card: JsonObject,
    reward_model: JsonObject,
    training_approach: Any,
) -> None:
    if training_approach != "policy_gradient":
        raise TrainingCardError("reward_model.scalar_weighted_sum_authorized requires training_approach=policy_gradient")
    if not card_scenario_supports_multi_tier_policy_comparison(card):
        raise TrainingCardError("reward_model.scalar_weighted_sum_authorized requires active multi-tier scenario evidence")
    scalar_use = first_present(reward_model, ("scalar_weighted_sum_use", "scalarWeightedSumUse"))
    if scalar_use != SCALAR_WEIGHTED_SUM_AUTHORIZED_USE:
        raise TrainingCardError(f"reward_model.scalar_weighted_sum_use must be {SCALAR_WEIGHTED_SUM_AUTHORIZED_USE}")
    config = first_mapping(reward_model, ("scalar_weighted_sum", "scalarWeightedSum"))
    if config is None:
        raise TrainingCardError("reward_model.scalar_weighted_sum must be present when scalar reward is authorized")
    if first_present(config, ("authorized", "scalar_weighted_sum_authorized", "scalarWeightedSumAuthorized")) is not True:
        raise TrainingCardError("reward_model.scalar_weighted_sum.authorized must be true when authorized")
    if first_present(config, ("use", "scalar_weighted_sum_use", "scalarWeightedSumUse")) != SCALAR_WEIGHTED_SUM_AUTHORIZED_USE:
        raise TrainingCardError(f"reward_model.scalar_weighted_sum.use must be {SCALAR_WEIGHTED_SUM_AUTHORIZED_USE}")
    if first_present(config, ("component_order", "componentOrder")) != list(SCALAR_WEIGHTED_REWARD_TIERS):
        raise TrainingCardError(
            "reward_model.scalar_weighted_sum.component_order must preserve reliability, territory, resources, kills, activation"
        )
    weights = first_mapping(config, ("component_weights", "componentWeights"))
    if weights is None:
        raise TrainingCardError("reward_model.scalar_weighted_sum.component_weights must be present")
    required_weights = (
        "alpha_reliability",
        "beta_territory",
        "gamma_resources",
        "delta_kills",
        "epsilon_activation",
    )
    for field in required_weights:
        value = weights.get(field)
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise TrainingCardError(
                f"reward_model.scalar_weighted_sum.component_weights.{field} must be a positive integer"
            )
    if not (
        weights["alpha_reliability"]
        > weights["beta_territory"]
        > weights["gamma_resources"]
        > weights["delta_kills"]
        >= weights["epsilon_activation"]
    ):
        raise TrainingCardError("reward_model.scalar_weighted_sum weights must preserve lexicographic dominance")


def card_scenario_supports_multi_tier_policy_comparison(card: JsonObject) -> bool:
    scenario = card.get("scenario", card.get("trainingScenario"))
    if not isinstance(scenario, dict):
        return False
    capabilities = scenario.get("capabilities")
    suitability = scenario.get("suitability")
    evidence = scenario.get("evidence")
    if not isinstance(capabilities, dict) or not isinstance(suitability, dict) or not isinstance(evidence, dict):
        return False
    hostile_fixture = text_or_none(first_present(evidence, ("hostile_fixture", "hostileFixture")))
    return (
        capabilities.get("multi_room_capable") is True
        and capabilities.get("adjacent_room_territory_signal") is True
        and capabilities.get("hostile_combat_signal") is True
        and capabilities.get("multi_tier_policy_comparison") is True
        and suitability.get("multi_tier_policy_comparison") is True
        and suitability.get("territory_combat_differentiation") is True
        and first_present(evidence, ("implementation_status", "implementationStatus")) == "active_fixture_validated"
        and bool(hostile_fixture)
    )


def validate_policy_gradient_scale_sample_plan(
    card: JsonObject,
    simulation: JsonObject,
    raw_variants: Sequence[Any],
) -> None:
    scale_environments = positive_int_value(first_present(simulation, ("scale_environments", "scaleEnvironments")))
    if scale_environments is None:
        return
    repetitions = positive_int_value(simulation.get("repetitions")) or DEFAULT_RUN_REPETITIONS
    policy_gradient = card.get("policy_gradient", card.get("policyGradient"))
    required_samples = DEFAULT_GRADIENT_TRUST_MIN_SAMPLES_PER_CANDIDATE
    if isinstance(policy_gradient, dict):
        required_samples = int(policy_update_gradient_stability_config(policy_gradient)["minimumSamplesPerCandidate"])
    sample_plan = policy_gradient_trust_sample_plan(
        repetitions=repetitions,
        scale_environments=scale_environments,
        variant_count=len(raw_variants),
        required_samples_per_candidate=required_samples,
    )
    if sample_plan["minimumSamplesPerCandidate"] < required_samples:
        raise TrainingCardError(
            "policy_gradient scale validation requires "
            f"requested samples per candidate >= {required_samples}; "
            f"planned minimum is {sample_plan['minimumSamplesPerCandidate']} with "
            f"{sample_plan['variantCount']} variant(s), {sample_plan['expandedRowCount']} expanded row(s), "
            f"and {sample_plan['repetitions']} repetition(s); "
            f"requires simulation.repetitions >= {sample_plan['requiredRepetitions']}"
        )


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


def validate_role_policy_lane_contract(card: JsonObject) -> None:
    contract = first_present(card, ("role_policy_lanes", "rolePolicyLanes", "policyLaneContract"))
    if contract is None:
        return
    try:
        role_policy_lanes.validate_lane_contract(contract, "role_policy_lanes")
    except role_policy_lanes.RolePolicyLaneError as error:
        raise TrainingCardError(str(error)) from error


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


def first_non_null_present(raw: JsonObject, keys: Sequence[str]) -> Any:
    for key in keys:
        if key in raw and raw[key] is not None:
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
    validate_role_policy_variants(variants, context="strategy_variants", parent=card)
    return variants


def validate_role_policy_variants(
    variants: Sequence[StrategyVariant],
    *,
    context: str,
    parent: JsonObject | None = None,
) -> None:
    try:
        role_policy_lanes.validate_role_policy_collection(
            [variant.to_json() for variant in variants],
            context=context,
            parent=parent,
        )
    except role_policy_lanes.RolePolicyLaneError as error:
        raise TrainingCardError(str(error)) from error


def apply_policy_gradient_candidate_vectors_to_variants(
    card: JsonObject,
    variants: Sequence[StrategyVariant],
) -> list[StrategyVariant]:
    """Use policy-gradient candidate vectors as the simulator runtime parameter source."""
    policy_gradient = card.get("policy_gradient", card.get("policyGradient"))
    if not isinstance(policy_gradient, dict):
        return list(variants)
    raw_candidates = first_present(policy_gradient, ("candidate_parameter_vectors", "candidateParameterVectors"))
    if not isinstance(raw_candidates, list):
        return list(variants)

    candidates_by_variant_id, candidates_by_policy_id = policy_gradient_candidate_vector_maps(policy_gradient)
    if not candidates_by_variant_id and not candidates_by_policy_id:
        return list(variants)

    return [
        policy_gradient_candidate_vector_variant(
            variant,
            candidates_by_variant_id,
            candidates_by_policy_id,
        )
        for variant in variants
    ]


def policy_gradient_candidate_vector_maps(
    policy_gradient: JsonObject | None,
) -> tuple[dict[str, JsonObject], dict[str, JsonObject]]:
    if policy_gradient is None:
        return {}, {}
    raw_candidates = first_present(policy_gradient, ("candidate_parameter_vectors", "candidateParameterVectors"))
    if not isinstance(raw_candidates, list):
        return {}, {}

    candidates_by_variant_id: dict[str, JsonObject] = {}
    candidates_by_policy_id: dict[str, JsonObject] = {}
    for raw_candidate in raw_candidates:
        if not isinstance(raw_candidate, dict):
            continue
        candidate = raw_candidate
        strategy_variant_id = text_or_none(candidate.get("strategyVariantId"))
        candidate_policy_id = text_or_none(candidate.get("candidatePolicyId"))
        if strategy_variant_id is not None:
            candidates_by_variant_id[strategy_variant_id] = candidate
        if candidate_policy_id is not None:
            candidates_by_policy_id.setdefault(candidate_policy_id, candidate)
    return candidates_by_variant_id, candidates_by_policy_id


def policy_gradient_candidate_vector_variant(
    variant: StrategyVariant,
    candidates_by_variant_id: dict[str, JsonObject],
    candidates_by_policy_id: dict[str, JsonObject],
) -> StrategyVariant:
    candidate = candidates_by_variant_id.get(variant.id)
    if candidate is None and variant.candidate_policy_id is not None:
        candidate = candidates_by_policy_id.get(variant.candidate_policy_id)
    if candidate is None:
        return variant

    raw_parameters = candidate.get("parameters")
    parameters = (
        dict(sorted(copy.deepcopy(raw_parameters).items()))
        if isinstance(raw_parameters, dict)
        else copy.deepcopy(variant.parameters)
    )
    parameter_evidence = first_mapping(candidate, ("parameterEvidence", "parameter_evidence"))
    return StrategyVariant(
        id=variant.id,
        parameters=parameters,
        candidate_policy_id=text_or_none(candidate.get("candidatePolicyId")) or variant.candidate_policy_id,
        family=text_or_none(candidate.get("family")) or variant.family,
        policy_family=(
            text_or_none(candidate.get("policyFamily"))
            or text_or_none(candidate.get("policy_family"))
            or variant.policy_family
        ),
        role_policy=(
            text_or_none(candidate.get("rolePolicy"))
            or text_or_none(candidate.get("role_policy"))
            or variant.role_policy
        ),
        parameter_evidence=copy.deepcopy(parameter_evidence)
        if parameter_evidence is not None
        else copy.deepcopy(variant.parameter_evidence),
        rollout_status=(
            text_or_none(candidate.get("rolloutStatus"))
            or text_or_none(candidate.get("rollout_status"))
            or variant.rollout_status
        ),
        source_strategy_id=(
            text_or_none(candidate.get("sourceStrategyId"))
            or text_or_none(candidate.get("source_strategy_id"))
            or variant.source_strategy_id
        ),
        source=variant.source,
        title=text_or_none(candidate.get("title")) or variant.title,
        training_role=(
            text_or_none(candidate.get("trainingRole"))
            or text_or_none(candidate.get("training_role"))
            or variant.training_role
        ),
    )


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
                policy_family=base.policy_family,
                role_policy=base.role_policy,
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
    policy_family = (
        text_or_none(raw.get("policyFamily"))
        or text_or_none(raw.get("policy_family"))
        or (registry_variant.policy_family if registry_variant else None)
    )
    role_policy = (
        text_or_none(raw.get("rolePolicy"))
        or text_or_none(raw.get("role_policy"))
        or (registry_variant.role_policy if registry_variant else None)
    )
    parameter_evidence = first_mapping(raw, ("parameterEvidence", "parameter_evidence"))
    rollout_status = (
        text_or_none(raw.get("rolloutStatus"))
        or text_or_none(raw.get("rollout_status"))
        or (registry_variant.rollout_status if registry_variant else None)
    )
    title = text_or_none(raw.get("title")) or (registry_variant.title if registry_variant else None)
    training_role = (
        text_or_none(raw.get("trainingRole"))
        or text_or_none(raw.get("training_role"))
        or (registry_variant.training_role if registry_variant else None)
    )
    try:
        role_policy_lanes.validate_role_policy_metadata(
            {
                "policyFamily": policy_family,
                "rolePolicy": role_policy,
                "trainingRole": training_role,
            },
            f"strategy variant {variant_id}",
        )
    except role_policy_lanes.RolePolicyLaneError as error:
        raise TrainingCardError(str(error)) from error
    return StrategyVariant(
        id=variant_id,
        parameters=dict(sorted(parameters.items())),
        candidate_policy_id=candidate_policy_id,
        family=family,
        policy_family=policy_family,
        role_policy=role_policy,
        parameter_evidence=copy.deepcopy(parameter_evidence) if parameter_evidence is not None else None,
        rollout_status=rollout_status,
        source_strategy_id=source_strategy_id,
        source=source,
        title=title,
        training_role=training_role,
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
            policy_family=regex_group(r"\bpolicyFamily:\s*['\"]([^'\"]+)['\"]", block),
            role_policy=regex_group(r"\brolePolicy:\s*['\"]([^'\"]+)['\"]", block),
            rollout_status=regex_group(r"\brolloutStatus:\s*['\"]([^'\"]+)['\"]", block),
            title=regex_group(r"\btitle:\s*['\"]([^'\"]+)['\"]", block),
            training_role=regex_group(r"\btrainingRole:\s*['\"]([^'\"]+)['\"]", block),
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


def scalar_weighted_sum_authorized(raw: Any) -> bool:
    if not isinstance(raw, dict):
        return False
    return first_present(raw, ("scalar_weighted_sum_authorized", "scalarWeightedSumAuthorized")) is True


def scalar_weighted_sum_use(raw: Any) -> str:
    if not isinstance(raw, dict):
        return "not_used"
    return (
        text_or_none(first_present(raw, ("scalar_weighted_sum_use", "scalarWeightedSumUse")))
        or "not_used"
    )


def policy_gradient_scalar_weighted_sum_authorized(policy_gradient: JsonObject) -> bool:
    reward_model = first_mapping(policy_gradient, ("reward_model", "rewardModel"))
    return scalar_weighted_sum_authorized(reward_model)


def runtime_parameter_transport_without_consumption_status(value: Any) -> bool:
    return text_or_none(value) in RUNTIME_PARAMETER_TRANSPORT_WITHOUT_CONSUMPTION_STATUSES


def runtime_parameter_consumption_blocker_status(value: Any) -> bool:
    return text_or_none(value) in RUNTIME_PARAMETER_CONSUMPTION_BLOCKER_STATUSES


def reward_options_from_card(card: JsonObject) -> JsonObject:
    reward_model = raw_mapping(card.get("reward_model", card.get("rewardModel", {})), "reward_model")
    weights = reward_model.get("component_weights", reward_model.get("componentWeights"))
    if not isinstance(weights, dict):
        weights = {}
    normalizers = reward_model.get("normalizers")
    if not isinstance(normalizers, dict):
        normalizers = {}
    scalar_authorized = scalar_weighted_sum_authorized(reward_model)
    options: JsonObject = {
        "componentOrder": list(REWARD_TIERS),
        "weights": weights,
        "resourceNormalizer": positive_float_value(
            reward_model.get("resource_normalizer", reward_model.get("resourceNormalizer", normalizers.get("resources")))
        )
        or DEFAULT_RESOURCE_NORMALIZER,
        "scalarWeightedSumAuthorized": scalar_authorized,
        "scalarWeightedSumUse": scalar_weighted_sum_use(reward_model) if scalar_authorized else "not_used",
    }
    if scalar_authorized:
        options["scalarWeightEvidence"] = policy_update_scalar_reward_weight_evidence({"rewardModel": reward_model})
        scalar_config = first_mapping(reward_model, ("scalar_weighted_sum", "scalarWeightedSum"))
        if scalar_config is not None:
            options["scalarWeightedSum"] = copy.deepcopy(scalar_config)
    return options


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
    variants = apply_policy_gradient_candidate_vectors_to_variants(card, variants)
    validate_role_policy_variants(variants, context="policy_gradient.candidate_parameter_vectors", parent=card)
    config = simulation_config_from_card(card)
    variants = expand_scale_environment_strategy_variants(variants, config.scale_environments)
    validate_role_policy_variants(variants, context="expanded_strategy_variants", parent=card)
    reward_options = reward_options_from_card(card)
    resolved_report_id = report_id or default_report_id(card, variants, config)
    validate_report_id(resolved_report_id)
    ensure_steam_key_for_training(simulator_runner=simulator_runner, env_file=steam_key_env_file)
    resolved_out_dir = out_dir.expanduser()
    previous_gradient_momentum_state = load_policy_gradient_momentum_state(
        policy_gradient_metadata_from_card(card),
        resolved_out_dir,
    )

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
        previous_gradient_momentum_state=previous_gradient_momentum_state,
    )
    report_secret_values = dataset_export.configured_secret_values() + [os.environ.get("STEAM_KEY", "")]
    assert_no_secret_leak(report, report_secret_values)
    report_path = resolved_out_dir / f"{resolved_report_id}.json"
    policy_artifacts = materialize_policy_update_artifacts(report, report_path.parent)
    for _artifact_path, artifact_payload in policy_artifacts:
        assert_no_secret_leak(artifact_payload, report_secret_values)
    for artifact_path, artifact_payload in policy_artifacts:
        write_json_atomic(artifact_path, artifact_payload)
    try:
        materialize_candidate_scorecard_artifact(report, report_path.parent, report_secret_values)
    except scorecard_helper.ScorecardError as error:
        mark_candidate_scorecard_materialization_failed(report, error)
    state_artifact_path = policy_gradient_momentum_state_artifact_path_for_report(report, report_path.parent)
    previous_state_artifact_bytes = None
    previous_state_artifact_existed = state_artifact_path is not None and state_artifact_path.exists()
    if previous_state_artifact_existed:
        try:
            assert state_artifact_path is not None
            previous_state_artifact_bytes = state_artifact_path.read_bytes()
        except OSError as error:
            warning = (
                "previous gradient momentum state artifact snapshot skipped: "
                f"{dataset_export.redact_text(str(error))}"
            )
            warnings = report.get("warnings")
            if isinstance(warnings, list):
                warnings.append(warning)
            else:
                report["warnings"] = [warning]
    materialized_state_artifact_path = materialize_policy_gradient_momentum_state(
        report,
        report_path.parent,
        report_path,
        report_secret_values,
    )
    try:
        assert_no_secret_leak(report, report_secret_values)
        write_json_atomic(report_path, report)
    except Exception:
        if materialized_state_artifact_path is not None:
            rollback_policy_gradient_momentum_state_artifact(
                materialized_state_artifact_path,
                previous_state_artifact_bytes,
                previous_artifact_existed=previous_state_artifact_existed,
            )
        raise
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
    variant_configs = {variant.id: variant.to_json() for variant in variants}
    raw_run_id = text_or_none(card.get("run_id")) or text_or_none(card.get("runId")) or report_id
    base_run_id = normalize_simulator_run_id(raw_run_id)
    runs: list[JsonObject] = []
    effective_workers = max(1, min(config.workers, len(variant_ids)))
    min_concurrent_environments = config.min_concurrent_environments or config.scale_environments or 0
    maybe_run_pre_scale_trainability_smoke_gate(
        simulator_runner=simulator_runner,
        variants=variants,
        variant_configs=variant_configs,
        config=config,
        base_run_id=base_run_id,
        min_concurrent_environments=min_concurrent_environments,
        effective_workers=effective_workers,
    )
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
                variant_configs=variant_configs,
            )
        )
    return runs


def maybe_run_pre_scale_trainability_smoke_gate(
    *,
    simulator_runner: SimulatorRunner,
    variants: Sequence[StrategyVariant],
    variant_configs: Mapping[str, JsonObject],
    config: SimulationConfig,
    base_run_id: str,
    min_concurrent_environments: int,
    effective_workers: int,
) -> JsonObject | None:
    if simulator_runner is not simulator_harness.run_simulator:
        return None
    if min_concurrent_environments <= 0 and config.scale_environments is None:
        return None
    smoke_variant = pre_scale_trainability_smoke_variant(variants)
    if smoke_variant is None:
        return None
    smoke_run_id = f"{base_run_id}-pre-scale-smoke"
    smoke_host_port_start = simulator_repetition_host_port_start(
        config.host_port_start,
        config.repetitions,
        effective_workers,
    )
    smoke_run = simulator_runner(
        ticks=PRE_SCALE_TRAINABILITY_SMOKE_TICKS,
        workers=1,
        variants=[smoke_variant.id],
        out_dir=config.simulator_out_dir,
        run_id=smoke_run_id,
        host_port_start=smoke_host_port_start,
        room=config.room,
        shard=config.shard,
        branch=config.branch,
        code_path=config.code_path,
        map_source_file=config.map_source_file,
        min_concurrent_environments=0,
        variant_configs=variant_configs,
    )
    assert_simulator_runs_shadow_safe([smoke_run])
    validate_pre_scale_trainability_smoke_gate(smoke_run, smoke_variant.id)
    return smoke_run


def pre_scale_trainability_smoke_variant(variants: Sequence[StrategyVariant]) -> StrategyVariant | None:
    for variant in variants:
        injection = simulator_harness.runtime_parameter_injection_for_variant(variant.id, variant.to_json())
        if injection.get("candidateParameterScope") == "runtime_injected":
            return variant
    return None


def validate_pre_scale_trainability_smoke_gate(smoke_run: JsonObject, variant_id: str) -> None:
    variants = smoke_run.get("variants") if isinstance(smoke_run, dict) else None
    rows = [item for item in variants if isinstance(item, dict)] if isinstance(variants, list) else []
    row = next(
        (
            item
            for item in rows
            if text_or_none(item.get("variant_id")) == variant_id
            or text_or_none(item.get("variantId")) == variant_id
            or text_or_none(item.get("id")) == variant_id
        ),
        None,
    )
    if row is None:
        raise RuntimeError("pre-scale private-simulator trainability smoke gate produced no variant result")
    if row.get("ok") is not True:
        reason = text_or_none(row.get("error")) or "variant smoke result was not ok"
        raise RuntimeError(f"pre-scale private-simulator trainability smoke gate failed: {reason}")
    active_code_error = simulator_harness.private_simulator_active_code_readback_error(row.get("activeCodeReadback"))
    if active_code_error is not None:
        raise RuntimeError(f"pre-scale private-simulator trainability smoke gate failed: {active_code_error}")
    injection = row.get("runtimeParameterInjection")
    consumption = row.get("runtimeParameterConsumption")
    if not isinstance(injection, dict) or injection.get("runtimeParameterInjection") is not True:
        raise RuntimeError("pre-scale private-simulator trainability smoke gate did not inject runtime parameters")
    if not isinstance(consumption, dict) or consumption.get("runtimeParameterConsumption") is not True:
        status = text_or_none(consumption.get("status")) if isinstance(consumption, dict) else None
        reason = text_or_none(consumption.get("reason")) if isinstance(consumption, dict) else None
        detail = status or "missing"
        if reason:
            detail = f"{detail}: {reason}"
        raise RuntimeError(
            "pre-scale private-simulator trainability smoke gate did not prove runtime parameter consumption: "
            f"{detail}"
        )
    consumed_tick = int_or_none(consumption.get("consumedTick"))
    if consumed_tick is None or consumed_tick <= 0:
        raise RuntimeError(
            "pre-scale private-simulator trainability smoke gate did not prove runtime parameter consumption: "
            "missing numeric consumedTick"
        )
    injection_tick = int_or_none(injection.get("tick"))
    if injection_tick is None:
        raise RuntimeError(
            "pre-scale private-simulator trainability smoke gate did not prove runtime parameter consumption: "
            "missing numeric injection tick"
        )
    if consumed_tick <= injection_tick:
        raise RuntimeError(
            "pre-scale private-simulator trainability smoke gate did not prove runtime parameter consumption: "
            f"consumedTick={consumed_tick} did not advance beyond injection tick={injection_tick}"
        )


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


def simulator_setup_policy_update_blocker(
    simulator_runs: Sequence[JsonObject],
    scale_validation: JsonObject | None,
) -> JsonObject | None:
    """Return setup-failure evidence that must block policy updates for degraded simulator runs."""
    if not isinstance(scale_validation, dict) or scale_validation.get("ok") is not False:
        return None
    room_busy_rows = simulator_place_spawn_room_busy_rows(simulator_runs)
    if not room_busy_rows:
        return None
    return {
        "classification": SIMULATOR_SETUP_PLACE_SPAWN_ROOM_BUSY_SKIP_REASON,
        "reason": (
            "simulator scale validation failed because at least one environment hit persistent "
            "place-spawn room-busy setup; setup failures are not policy reward evidence"
        ),
        "failedEnvironmentCount": scale_validation.get("failedEnvironments"),
        "successfulEnvironmentCount": scale_validation.get("successfulEnvironments"),
        "totalEnvironmentCount": scale_validation.get("totalEnvironments"),
        "minimumSuccessfulEnvironments": scale_validation.get("minimumSuccessfulEnvironments"),
        "evidence": room_busy_rows[:10],
        "evidenceCount": len(room_busy_rows),
        "nextAction": (
            "repair simulator spawn allocation/setup before emitting a policy update from this training slice"
        ),
    }


def simulator_place_spawn_room_busy_rows(simulator_runs: Sequence[JsonObject]) -> list[JsonObject]:
    rows: list[JsonObject] = []
    for run_index, run in enumerate(simulator_runs):
        if not isinstance(run, dict):
            continue
        run_id = text_or_none(run.get("runId")) or f"run[{run_index}]"
        variants = run.get("variants")
        if not isinstance(variants, list):
            continue
        for variant_index, variant in enumerate(variants):
            if not isinstance(variant, dict):
                continue
            if variant.get("ok") is True:
                continue
            if not variant_has_place_spawn_room_busy(variant):
                continue
            evidence: JsonObject = {
                "runId": run_id,
                "runIndex": run_index,
                "variantIndex": variant_index,
                "variantId": text_or_none(variant.get("variant_id", variant.get("variantId"))),
                "ok": variant.get("ok") is True,
                "ticksRun": number_or_none(variant.get("ticks_run", variant.get("ticksRun"))),
                "error": text_or_none(variant.get("error")),
            }
            place_spawn = variant.get("placeSpawn")
            if isinstance(place_spawn, dict):
                evidence["placeSpawn"] = {
                    "classification": text_or_none(place_spawn.get("classification")),
                    "phase": text_or_none(place_spawn.get("phase")),
                    "maxAttempts": int_or_none(place_spawn.get("maxAttempts")),
                }
            rows.append(evidence)
    return rows


def variant_has_place_spawn_room_busy(variant: JsonObject) -> bool:
    place_spawn = variant.get("placeSpawn")
    if isinstance(place_spawn, dict):
        classification = text_or_none(place_spawn.get("classification"))
        if classification in {"place_spawn_room_busy", "room_busy"}:
            return True
    texts: list[str] = []
    for key in ("error", "diagnostic", "reason"):
        value = text_or_none(variant.get(key))
        if value is not None:
            texts.append(value)
    errors = variant.get("errors")
    if isinstance(errors, list):
        texts.extend(str(error) for error in errors if error is not None)
    combined = "\n".join(texts).lower()
    return "place-spawn room busy" in combined or "place_spawn_room_busy" in combined


def build_simulator_setup_blocked_policy_update(
    *,
    policy_gradient: JsonObject,
    blocker: JsonObject,
) -> JsonObject:
    algorithm = policy_update_algorithm(policy_gradient)
    target_family = text_or_none(policy_gradient.get("target_family", policy_gradient.get("targetFamily"))) or "unknown"
    runtime_injected = not policy_gradient_candidate_parameters_metadata_only(policy_gradient)
    parameter_evidence: JsonObject = {
        "candidateParameterScope": "runtime_injected" if runtime_injected else "metadata_only",
        "runtimeParameterInjection": runtime_injected,
        "runtimeParameterConsumption": False,
        "runtimeParameterConsumptionStatus": "blocked_by_simulator_setup",
        "policyUpdateEligible": False,
        "reason": blocker["reason"],
        "setupFailureClassification": blocker["classification"],
        "simulatorSetupBlocker": copy.deepcopy(blocker),
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }
    return {
        **build_policy_update_base(algorithm=algorithm, target_family=target_family),
        "skippedReason": SIMULATOR_SETUP_PLACE_SPAWN_ROOM_BUSY_SKIP_REASON,
        "candidateCount": policy_gradient_candidate_vector_count(policy_gradient),
        "parameterEvidence": parameter_evidence,
        "simulatorSetupBlocker": copy.deepcopy(blocker),
        "promotionGate": policy_update_promotion_gate(parameter_evidence, policy_update_generated=False),
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


def build_report_runtime_parameter_injection_summary(
    results: Sequence[JsonObject],
    variants: Sequence[StrategyVariant],
    policy_gradient: JsonObject | None = None,
) -> JsonObject:
    candidate_match_ids = policy_gradient_candidate_match_ids(policy_gradient, variants)
    expected_ids = set(candidate_match_ids.values()) if candidate_match_ids else {variant.id for variant in variants}
    rows: list[JsonObject] = []
    observed_ids: set[str] = set()
    for result in results:
        raw_variant_id = text_or_none(result.get("variantId"))
        if raw_variant_id is None:
            continue
        base_variant_id = simulator_harness.scale_environment_base_variant_id(raw_variant_id)
        expected_id = candidate_match_ids.get(base_variant_id) if candidate_match_ids else raw_variant_id
        if expected_id is None:
            continue
        observed_ids.add(expected_id)
        variant_id = raw_variant_id
        injection = result.get("runtimeParameterInjection")
        if isinstance(injection, dict):
            runtime_injected = (
                injection.get("runtimeParameterInjection") is True
                or runtime_parameter_injected_attempt_count(injection) > 0
            )
            row = {
                "variantId": variant_id,
                "status": injection.get("status"),
                "runtimeParameterInjection": runtime_injected,
                "candidateParameterScope": injection.get("candidateParameterScope"),
                "parametersSha256": injection.get("parametersSha256"),
                "reason": injection.get("reason"),
            }
            for field in ("candidatePolicyId", "sourceStrategyId", "family", "policyFamily", "rolePolicy", "trainingRole"):
                value = injection.get(field)
                if value is None:
                    value = result.get(field)
                if value is not None:
                    row[field] = copy.deepcopy(value)
            for field in (
                "runtimeParameterConsumption",
                "runtimeParameterConsumptionStatus",
                "runtimeParameterConsumptionSource",
                "runtimeParameterConsumer",
                "runtimeParameterConsumerVersion",
                "evaluatedParametersSource",
                "evaluatedParametersSha256",
                "consumedParametersSha256",
                "consumedStrategyVariantId",
                "consumedTick",
                "appliedStrategyIds",
            ):
                if field in injection:
                    row[field] = copy.deepcopy(injection.get(field))
            rows.append(row)
        else:
            rows.append({
                "variantId": variant_id,
                "status": "missing",
                "runtimeParameterInjection": False,
                "candidateParameterScope": "metadata_only",
                "reason": "variant summary did not include runtime parameter injection evidence",
            })
    for missing in sorted(expected_ids - observed_ids):
        rows.append({
            "variantId": missing,
            "status": "missing",
            "runtimeParameterInjection": False,
            "candidateParameterScope": "metadata_only",
            "reason": "variant was missing from training results",
        })

    injected_count = sum(1 for row in rows if row.get("runtimeParameterInjection") is True)
    consumed_count = sum(
        1
        for row in rows
        if row.get("runtimeParameterInjection") is True and row.get("runtimeParameterConsumption") is True
    )
    partial_count = sum(
        1
        for row in rows
        if row.get("status") == "partial" or row.get("candidateParameterScope") == "partial_runtime_injection"
    )
    attempted_runtime_count = sum(1 for row in rows if runtime_parameter_scope_indicates_runtime_attempt(row))
    complete_runtime_injection = bool(rows) and injected_count == len(rows)
    complete_runtime_consumption = complete_runtime_injection and consumed_count == len(rows)
    complete_transport_without_consumption = (
        complete_runtime_injection
        and consumed_count == 0
        and all(
            runtime_parameter_transport_without_consumption_status(
                row.get("runtimeParameterConsumptionStatus")
            )
            for row in rows
        )
    )
    if complete_runtime_consumption:
        status = "injected"
        reason = None
        runtime_injected = True
        eligible = True
        scope = "runtime_injected"
    elif complete_transport_without_consumption:
        status = "injected"
        reason = "runtime-injected candidate parameters were uploaded, but not every candidate reported consumption"
        runtime_injected = True
        eligible = False
        scope = "runtime_injected"
    elif injected_count > 0 or partial_count > 0:
        status = "partial"
        reason = (
            "not every candidate variant had consumed runtime-injected parameter evidence"
            if injected_count == len(rows)
            else "not every candidate variant had runtime-injected parameter evidence"
        )
        runtime_injected = False
        eligible = False
        scope = "partial_runtime_injection"
    elif attempted_runtime_count > 0:
        status = "not_injected"
        first_reason = next((row.get("reason") for row in rows if row.get("reason")), None)
        reason = str(first_reason) if first_reason else "runtime-injected candidate parameters had no successful evidence"
        runtime_injected = False
        eligible = False
        scope = "runtime_injected"
    else:
        status = "metadata_only"
        first_reason = next((row.get("reason") for row in rows if row.get("reason")), None)
        reason = str(first_reason) if first_reason else "candidate parameters were not injected into simulator runtime inputs"
        runtime_injected = False
        eligible = False
        scope = "metadata_only"

    payload: JsonObject = {
        "type": simulator_harness.RUNTIME_PARAMETER_INJECTION_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "status": status,
        "mechanism": simulator_harness.RUNTIME_PARAMETER_INJECTION_MECHANISM,
        "runtimeParameterInjection": runtime_injected,
        "inlineCandidatesRuntimeInjected": runtime_injected,
        "candidateParameterScope": scope,
        "policyUpdateEligible": eligible,
        "variantCount": len(rows),
        "injectedVariantCount": injected_count,
        "runtimeParameterConsumption": complete_runtime_consumption,
        "runtimeParameterConsumptionStatus": runtime_parameter_consumption_rollup_status(rows),
        "consumedVariantCount": consumed_count,
        "variants": rows,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }
    if reason:
        payload["reason"] = reason
    return payload


def runtime_parameter_consumption_rollup_status(rows: Sequence[JsonObject]) -> str:
    if not rows:
        return "missing"
    consumed = sum(
        1
        for row in rows
        if row.get("runtimeParameterInjection") is True and row.get("runtimeParameterConsumption") is True
    )
    if consumed == len(rows):
        return "consumed"
    if consumed > 0:
        return "partial"
    statuses = [
        text_or_none(
            row.get("runtimeParameterConsumptionStatus")
            if "runtimeParameterConsumptionStatus" in row
            else row.get("status")
        )
        for row in rows
        if text_or_none(
            row.get("runtimeParameterConsumptionStatus")
            if "runtimeParameterConsumptionStatus" in row
            else row.get("status")
        )
        is not None
    ]
    if statuses:
        first = statuses[0]
        return first if all(status == first for status in statuses) else "mixed"
    return "missing" if any(runtime_parameter_scope_indicates_runtime_attempt(row) for row in rows) else "not_attempted"


def runtime_parameter_injected_attempt_count(injection: JsonObject) -> int:
    attempts = injection.get("attempts")
    if not isinstance(attempts, list):
        return 1 if injection.get("runtimeParameterInjection") is True else 0
    return sum(
        1
        for attempt in attempts
        if isinstance(attempt, dict) and attempt.get("runtimeParameterInjection") is True
    )


def policy_gradient_candidate_match_ids(
    policy_gradient: JsonObject | None,
    variants: Sequence[StrategyVariant] = (),
) -> dict[str, str]:
    if policy_gradient is None:
        return {}
    raw_candidates = first_present(policy_gradient, ("candidate_parameter_vectors", "candidateParameterVectors"))
    if not isinstance(raw_candidates, list):
        return {}
    match_ids: dict[str, str] = {}
    for candidate in raw_candidates:
        if not isinstance(candidate, dict):
            continue
        strategy_variant_id = text_or_none(candidate.get("strategyVariantId"))
        candidate_policy_id = text_or_none(candidate.get("candidatePolicyId"))
        expected_id = strategy_variant_id or candidate_policy_id
        if expected_id is None:
            continue
        match_ids[expected_id] = expected_id
        if candidate_policy_id is not None:
            match_ids[candidate_policy_id] = expected_id
    for variant in variants:
        if variant.candidate_policy_id is None:
            continue
        expected_id = match_ids.get(variant.candidate_policy_id)
        if expected_id is None:
            continue
        match_ids.setdefault(variant.id, expected_id)
        base_variant_id = simulator_harness.scale_environment_base_variant_id(variant.id)
        match_ids.setdefault(base_variant_id, expected_id)
    return match_ids


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
    previous_gradient_momentum_state: JsonObject | None = None,
) -> JsonObject:
    per_variant_runs = collect_variant_runs(simulator_runs, [variant.id for variant in variants])
    scenario = scenario_metadata_from_card(card)
    activation_fixture_loader = multi_tier_policy_activation_fixture_loader(scenario, config)
    results = [
        summarize_variant(
            variant,
            per_variant_runs.get(variant.id, []),
            reward_options,
            multi_tier_fixture_loader=activation_fixture_loader,
        )
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
    artifact_count = sum(result["sampleCount"] for result in results)
    batch_scale = scale_gates.build_batch_scale_summary(
        environment_rows=artifact_count,
        simulator_ticks=training_simulator_ticks(simulator_runs),
        wall_clock_seconds=training_wall_clock_seconds(simulator_runs),
        basis="training_report",
    )
    raw_policy_gradient = raw_policy_gradient_metadata_from_card(card)
    runtime_parameter_injection = (
        build_report_runtime_parameter_injection_summary(results, variants, raw_policy_gradient)
        if raw_policy_gradient is not None
        else None
    )
    policy_gradient = policy_gradient_metadata_from_card(card, runtime_parameter_injection=runtime_parameter_injection)
    if policy_gradient is not None and isinstance(previous_gradient_momentum_state, dict):
        policy_gradient = policy_gradient_with_loaded_gradient_momentum_state(
            policy_gradient,
            previous_gradient_momentum_state,
        )
    if (
        policy_gradient is not None
        and scenario is not None
        and not scenario_supports_multi_tier_policy_comparison(scenario)
    ):
        warnings.append(
            "experiment card scenario is classified as not suitable for multi-tier territory/combat policy comparison"
        )
    scalar_weighted_reward = build_scalar_weighted_reward_report(scored_results, reward_options)

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
        "experimentCard": summarize_card(card, card_path, runtime_parameter_injection=runtime_parameter_injection),
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
        "rewardModel": build_report_reward_model(reward_options),
        "strategyVariants": [variant.to_json() for variant in variants],
        "candidateStrategyIds": [variant.id for variant in variants],
        "incumbentStrategyIds": incumbent_ids,
        "artifactCount": artifact_count,
        "batchScale": batch_scale,
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
        "gradientStable": False,
        "trustedGradientUpdate": False,
        "highVariance": False,
        "gradientEstimation": None,
        "gradientMomentum": None,
        "modelFamilies": sorted({text for text in (result.get("family") for result in results) if isinstance(text, str)}),
        "policyFamilies": sorted(
            {text for text in (result.get("policyFamily") for result in results) if isinstance(text, str)}
        ),
        "modelReports": model_reports,
        "kpiSummary": build_kpi_summary(scored_results),
        "warnings": warnings,
    }
    if scalar_weighted_reward is not None:
        report["scalarWeightedReward"] = scalar_weighted_reward
    if scenario is not None:
        report["scenario"] = scenario
        activation_proof = build_multi_tier_activation_proof(
            results=results,
            scenario=scenario,
            kpi_summary=report["kpiSummary"],
            audit=build_multi_tier_activation_audit(
                card=card,
                variants=variants,
                config=config,
                scenario=scenario,
                report_id=report_id,
                generated_at=generated_at,
            ),
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
    if runtime_parameter_injection is not None:
        report["runtimeParameterInjection"] = runtime_parameter_injection
    if policy_gradient is not None:
        report["policyGradient"] = policy_gradient
        setup_blocker = simulator_setup_policy_update_blocker(simulator_runs, scale_validation)
        if setup_blocker is not None:
            policy_update = build_simulator_setup_blocked_policy_update(
                policy_gradient=policy_gradient,
                blocker=setup_blocker,
            )
        else:
            policy_update = build_policy_update(
                policy_gradient=policy_gradient,
                results=results,
                report_id=report_id,
                generated_at=generated_at,
            )
        report["policyUpdateIterations"] = int(policy_update.get("iterations", 0))
        policy_update_algorithm_name = text_or_none(policy_update.get("algorithm"))
        report["policyUpdateAlgorithm"] = policy_update_algorithm_name
        report["trueGradient"] = policy_update.get("trueGradient") is True
        next_candidate_policy = policy_update.get("nextCandidatePolicy")
        if isinstance(next_candidate_policy, dict):
            report["policyUpdateCandidatePolicyId"] = text_or_none(next_candidate_policy.get("candidatePolicyId"))
        promotion_gate = policy_update.get("promotionGate")
        if isinstance(promotion_gate, dict):
            report["policyUpdatePromotionGate"] = copy.deepcopy(promotion_gate)
        gradient_stability = policy_update.get("gradientStability")
        if isinstance(gradient_stability, dict):
            report["gradientStability"] = copy.deepcopy(gradient_stability)
            report["gradientStable"] = gradient_stability.get("gradientStable") is True
            report["trustedGradientUpdate"] = gradient_stability.get("trustedUpdate") is True
            report["highVariance"] = gradient_stability.get("highVariance") is True
            trust_gate_reason = text_or_none(gradient_stability.get("reason"))
            trust_gate_classification = text_or_none(gradient_stability.get("classification"))
            if trust_gate_reason is not None:
                report["gradientTrustGateReason"] = trust_gate_reason
                if report["highVariance"]:
                    report["highVarianceReason"] = trust_gate_reason
            if trust_gate_classification is not None:
                report["gradientTrustGateClassification"] = trust_gate_classification
        gradient_estimation = policy_update.get("gradientEstimation")
        if isinstance(gradient_estimation, dict):
            report["gradientEstimation"] = copy.deepcopy(gradient_estimation)
            report["gradientEstimationSchemeKey"] = text_or_none(gradient_estimation.get("schemeKey"))
            report["gradientComparisonKey"] = text_or_none(gradient_estimation.get("comparisonKey"))
            scheme_identity = first_mapping(gradient_estimation, ("schemeIdentity",))
            if scheme_identity is not None:
                report["gradientEstimationScheme"] = copy.deepcopy(scheme_identity)
        gradient_momentum = policy_update.get("gradientMomentum")
        if isinstance(gradient_momentum, dict):
            report["gradientMomentum"] = copy.deepcopy(gradient_momentum)
        report["policyUpdate"] = policy_update
    if scalar_weighted_reward is not None:
        report["conclusionRegistryUpdate"] = scalar_weighted_reward_conclusion_registry_update(report)
    role_policy_summary = role_policy_lanes.summarize_role_policy_collection(results, parent=card)
    report["rolePolicies"] = role_policy_summary["rolePolicies"]
    report["trainingRoles"] = role_policy_summary["trainingRoles"]
    report["rolePolicyMetadata"] = role_policy_summary
    report["rolePolicyLanes"] = copy.deepcopy(
        first_present(card, ("role_policy_lanes", "rolePolicyLanes", "policyLaneContract"))
        or role_policy_lanes.role_policy_contract()
    )
    return report


def build_report_reward_model(reward_options: JsonObject) -> JsonObject:
    payload: JsonObject = {
        "type": "lexicographic",
        "componentOrder": list(REWARD_TIERS),
        "resourceNormalizer": reward_options["resourceNormalizer"],
        "formula": (
            "compare (successful simulator run share, roomsGained - roomsLost, "
            "(storedEnergyDelta + collectedEnergy) / resourceNormalizer, "
            "hostileKills - ownLosses) lexicographically"
        ),
        "scalarWeightedSumAuthorized": reward_options.get("scalarWeightedSumAuthorized") is True,
        "scalarWeightedSumUse": reward_options.get("scalarWeightedSumUse") or "not_used",
        "expansionSurvival": "claimed rooms count as held only with at least one spawn and one owned creep at end",
    }
    if reward_options.get("scalarWeightedSumAuthorized") is True:
        payload["scalarWeightedSum"] = {
            "authorized": True,
            "use": reward_options.get("scalarWeightedSumUse") or SCALAR_WEIGHTED_SUM_AUTHORIZED_USE,
            "rankingRewardModel": POLICY_GRADIENT_LEXICOGRAPHIC_REWARD,
            "componentOrder": list(SCALAR_WEIGHTED_REWARD_TIERS),
            "weightEvidence": copy.deepcopy(reward_options.get("scalarWeightEvidence")),
            "activationScoreSource": (
                "multiTierActivationTraces.policyActivation.activationScore; missing activation scores are zero"
            ),
            "promotionUse": "blocked_until_trusted_samples_and_loop_b_advantage_gate",
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
            "safety": safety_metadata(),
        }
    return payload


def build_scalar_weighted_reward_report(
    results: Sequence[JsonObject],
    reward_options: JsonObject,
) -> JsonObject | None:
    if reward_options.get("scalarWeightedSumAuthorized") is not True:
        return None
    variant_rewards = []
    for result in results:
        reward = result.get("reward") if isinstance(result.get("reward"), dict) else {}
        scalar_reward = reward.get("scalarWeightedSum") if isinstance(reward, dict) else None
        if not isinstance(scalar_reward, dict):
            continue
        variant_rewards.append({
            "variantId": result.get("variantId"),
            "rolloutStatus": result.get("rolloutStatus"),
            "rewardTuple": copy.deepcopy(reward.get("tuple")),
            "scalarReward": scalar_reward.get("scalarReward"),
            "activationScore": scalar_reward.get("activationScore"),
            "componentValuesByRewardTier": copy.deepcopy(scalar_reward.get("componentValuesByRewardTier")),
            "weightedComponentsByRewardTier": copy.deepcopy(scalar_reward.get("weightedComponentsByRewardTier")),
            "sampleCount": scalar_reward.get("sampleCount"),
        })
    return {
        "type": "screeps-rl-scalar-weighted-reward-activation-report",
        "schemaVersion": SCHEMA_VERSION,
        "authorized": True,
        "use": reward_options.get("scalarWeightedSumUse") or SCALAR_WEIGHTED_SUM_AUTHORIZED_USE,
        "rankingRewardModel": POLICY_GRADIENT_LEXICOGRAPHIC_REWARD,
        "componentOrder": list(SCALAR_WEIGHTED_REWARD_TIERS),
        "weightEvidence": copy.deepcopy(reward_options.get("scalarWeightEvidence")),
        "variantRewards": variant_rewards,
        "promotionBlockedUntil": [
            "issue_1337_trusted_samples_per_candidate",
            "loop_b_policy_advantage_gate",
        ],
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }


def scalar_weighted_reward_conclusion_registry_update(report: JsonObject) -> JsonObject:
    promotion_gate = report.get("policyUpdatePromotionGate")
    return {
        "type": "screeps-rl-conclusion-registry-update",
        "schemaVersion": SCHEMA_VERSION,
        "sourceIssue": "#1582",
        "registryPath": "runtime-artifacts/rl-control-loop/conclusion-registry.json",
        "status": "blocked",
        "classification": "scalar_weighted_reward_activation_shadow_only",
        "newConclusionIds": ["ISSUE-1582-SCALAR-WEIGHTED-REWARD-ACTIVATION"],
        "appendedToExisting": [],
        "loopA": {
            "promotionEligible": False,
            "missingPrerequisites": ["issue_1337_trusted_samples_per_candidate", "loop_b_policy_advantage_gate"],
        },
        "loopB": {
            "promotionEligible": False,
            "missingPrerequisites": ["loop_b_policy_advantage_gate"],
        },
        "promotionGate": copy.deepcopy(promotion_gate) if isinstance(promotion_gate, dict) else None,
        "reason": (
            "scalar weighted reward activation is authorized only for offline/private/shadow comparison; "
            "promotion remains blocked until trusted sample evidence and Loop B advantage gates pass"
        ),
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }


def training_simulator_ticks(simulator_runs: Sequence[JsonObject]) -> int:
    total = 0
    for run in simulator_runs:
        run_total = int_or_none(run.get("total_ticks", run.get("totalTicks"))) if isinstance(run, dict) else None
        if run_total is not None:
            total += run_total
            continue
        variants = run.get("variants") if isinstance(run, dict) else None
        if not isinstance(variants, list):
            continue
        for variant in variants:
            if not isinstance(variant, dict):
                continue
            total += int_or_none(variant.get("ticks_run", variant.get("ticksRun"))) or 0
    return total


def training_wall_clock_seconds(simulator_runs: Sequence[JsonObject]) -> float | None:
    total = 0.0
    observed = False
    for run in simulator_runs:
        if not isinstance(run, dict):
            continue
        run_wall = number_or_none(run.get("wallClockSeconds", run.get("wall_clock_seconds")))
        if run_wall is not None:
            total += float(run_wall)
            observed = True
            continue
        variants = run.get("variants")
        if not isinstance(variants, list):
            continue
        variant_wall = [
            float(value)
            for variant in variants
            if isinstance(variant, dict)
            for value in [number_or_none(variant.get("wall_clock_seconds", variant.get("wallClockSeconds")))]
            if value is not None
        ]
        if variant_wall:
            total += max(variant_wall)
            observed = True
    return total if observed else None


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
    if policy_gradient_candidate_parameters_metadata_only(policy_gradient):
        parameter_evidence = policy_update_metadata_only_parameter_evidence()
        return {
            **base,
            "skippedReason": METADATA_ONLY_POLICY_UPDATE_SKIP_REASON,
            "candidateCount": 0,
            "metadataCandidateCount": policy_gradient_candidate_vector_count(policy_gradient),
            "parameterEvidence": parameter_evidence,
            "promotionGate": policy_update_promotion_gate(parameter_evidence, policy_update_generated=False),
        }
    if policy_gradient_requires_runtime_parameter_evidence(policy_gradient) and len(candidates) < policy_gradient_candidate_vector_count(policy_gradient):
        parameter_evidence = policy_update_runtime_injection_incomplete_parameter_evidence(policy_gradient)
        return {
            **base,
            "skippedReason": RUNTIME_PARAMETER_INJECTION_INCOMPLETE_SKIP_REASON,
            "candidateCount": len(candidates),
            "metadataCandidateCount": policy_gradient_candidate_vector_count(policy_gradient),
            "parameterEvidence": parameter_evidence,
            "promotionGate": policy_update_promotion_gate(parameter_evidence, policy_update_generated=False),
        }
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

    parameter_evidence = policy_update_runtime_injection_ready_parameter_evidence(policy_gradient, candidates)
    if parameter_evidence.get("policyUpdateEligible") is not True:
        return {
            **base,
            "skippedReason": RUNTIME_PARAMETER_INJECTION_INCOMPLETE_SKIP_REASON,
            "candidateCount": len(candidates),
            "metadataCandidateCount": policy_gradient_candidate_vector_count(policy_gradient),
            "parameterEvidence": parameter_evidence,
            "anchor": policy_update_candidate_summary(anchor),
            "candidateRewards": [policy_update_candidate_summary(row) for row in candidates],
            "learningRate": learning_rate,
            "gradient": gradient,
            "promotionGate": policy_update_promotion_gate(parameter_evidence, policy_update_generated=False),
        }

    if not any(abs(float(value)) > 0 for value in parameter_delta.values()):
        return {
            **base,
            "skippedReason": "bounded_update_no_parameter_change",
            "candidateCount": len(candidates),
            "parameterEvidence": parameter_evidence,
            "anchor": policy_update_candidate_summary(anchor),
            "candidateRewards": [policy_update_candidate_summary(row) for row in candidates],
            "learningRate": learning_rate,
            "gradient": gradient,
            "promotionGate": policy_update_promotion_gate(parameter_evidence, policy_update_generated=False),
        }

    candidate_policy_id = updated_candidate_policy_id(
        target_family=target_family,
        report_id=report_id,
        parameters=updated_parameters,
    )
    promotion_gate = policy_update_promotion_gate(parameter_evidence, policy_update_generated=True)
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
        "runtimeParameterConsumption": promotion_gate["runtimeParameterConsumption"],
        "runtimeParameterConsumptionStatus": promotion_gate["runtimeParameterConsumptionStatus"],
        "consumptionMode": promotion_gate["consumptionMode"],
        "promotionGate": copy.deepcopy(promotion_gate),
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
            "runtimeParameterConsumption": promotion_gate["runtimeParameterConsumption"],
            "runtimeParameterConsumptionStatus": promotion_gate["runtimeParameterConsumptionStatus"],
            "consumptionMode": promotion_gate["consumptionMode"],
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
        "parameterEvidence": parameter_evidence,
        "anchor": policy_update_candidate_summary(anchor),
        "candidateRewards": [policy_update_candidate_summary(row) for row in candidates],
        "advantageByStrategyVariantId": advantages,
        "gradient": gradient,
        "parameterDelta": parameter_delta,
        "updatedParameters": updated_parameters,
        "runtimeParameterConsumption": promotion_gate["runtimeParameterConsumption"],
        "runtimeParameterConsumptionStatus": promotion_gate["runtimeParameterConsumptionStatus"],
        "consumptionMode": promotion_gate["consumptionMode"],
        "promotionGate": promotion_gate,
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
    if policy_gradient_candidate_parameters_metadata_only(policy_gradient):
        parameter_evidence = policy_update_metadata_only_parameter_evidence()
        return {
            **base,
            "skippedReason": METADATA_ONLY_POLICY_UPDATE_SKIP_REASON,
            "candidateCount": 0,
            "metadataCandidateCount": policy_gradient_candidate_vector_count(policy_gradient),
            "parameterEvidence": parameter_evidence,
            "promotionGate": policy_update_promotion_gate(parameter_evidence, policy_update_generated=False),
        }
    if policy_gradient_requires_runtime_parameter_evidence(policy_gradient) and len(candidates) < policy_gradient_candidate_vector_count(policy_gradient):
        parameter_evidence = policy_update_runtime_injection_incomplete_parameter_evidence(policy_gradient)
        return {
            **base,
            "skippedReason": RUNTIME_PARAMETER_INJECTION_INCOMPLETE_SKIP_REASON,
            "candidateCount": len(candidates),
            "metadataCandidateCount": policy_gradient_candidate_vector_count(policy_gradient),
            "parameterEvidence": parameter_evidence,
            "promotionGate": policy_update_promotion_gate(parameter_evidence, policy_update_generated=False),
        }
    if len(candidates) < 2:
        return {**base, "skippedReason": "fewer_than_two_scored_policy_candidates", "candidateCount": len(candidates)}

    anchor = policy_update_anchor_candidate(candidates)
    if anchor is None:
        return {**base, "skippedReason": "missing_anchor_policy_candidate", "candidateCount": len(candidates)}

    samples = policy_update_return_sample_rows(candidates)
    if len(samples) < 2:
        return_baseline = mean_policy_return_tuple([sample["returnTuple"] for sample in samples])
        gradient_stability = policy_update_gradient_stability_gate(
            policy_gradient=policy_gradient,
            parameter_space=parameter_space,
            candidates=candidates,
            samples=samples,
            anchor_parameters=anchor["parameters"],
            return_baseline=return_baseline,
            gradient={},
            selected_reward_tier_by_parameter={},
        )
        parameter_evidence = policy_update_runtime_injection_ready_parameter_evidence(policy_gradient, candidates)
        parameter_evidence = {
            **parameter_evidence,
            "policyUpdateEligible": False,
            "reason": (
                "policy-gradient rewards had runtime parameter evidence, but fewer than two "
                "Monte Carlo return samples makes the update untrusted and non-eligible"
            ),
        }
        return {
            **base,
            "skippedReason": "fewer_than_two_monte_carlo_return_samples",
            "candidateCount": len(candidates),
            "parameterEvidence": parameter_evidence,
            "anchor": policy_update_candidate_summary(anchor),
            "candidateRewards": [policy_update_candidate_summary(row) for row in candidates],
            "gradientStability": gradient_stability,
            "gradientStable": False,
            "trustedGradientUpdate": False,
            "highVariance": True,
            "promotionGate": policy_update_promotion_gate(
                parameter_evidence,
                policy_update_generated=False,
                gradient_stability=gradient_stability,
            ),
        }

    return_baseline = mean_policy_return_tuple([sample["returnTuple"] for sample in samples])
    learning_rate = policy_update_learning_rate(policy_gradient)
    bounded_integer_step = policy_update_uses_bounded_integer_step(policy_gradient)
    anchor_parameters = anchor["parameters"]
    anchor_return_baseline = policy_update_candidate_return_baseline(anchor)
    scalar_weighted_authorized = policy_gradient_scalar_weighted_sum_authorized(policy_gradient)
    if scalar_weighted_authorized:
        gradient_estimation = policy_update_scalar_weighted_gradient_estimation(
            policy_gradient=policy_gradient,
            parameter_space=parameter_space,
            samples=samples,
            anchor_parameters=anchor_parameters,
        )
    else:
        gradient_estimation = policy_update_lexicographic_reinforce_gradient_estimation(
            policy_gradient=policy_gradient,
            parameter_space=parameter_space,
            samples=samples,
            anchor_parameters=anchor_parameters,
            anchor_return_baseline=anchor_return_baseline,
        )
    raw_gradient = gradient_estimation["gradient"]
    gradient_by_tier = gradient_estimation.get("gradientByRewardTier", {})
    selected_reward_tier_by_parameter = gradient_estimation.get("selectedRewardTierByParameter", {})
    gradient_momentum = policy_update_gradient_momentum_evidence(
        policy_gradient=policy_gradient,
        raw_gradient=raw_gradient,
        gradient_estimation=gradient_estimation,
    )
    gradient = gradient_momentum.get("rawEmaGradient", gradient_momentum["emaGradient"])
    updated_parameters: JsonObject = {}
    parameter_delta: JsonObject = {}
    for name, spec in parameter_space.items():
        anchor_value = float(anchor_parameters[name])
        span = max(float(spec["max"]) - float(spec["min"]), 1.0)
        gradient_value = float(gradient.get(name, 0))
        if bounded_integer_step:
            updated = bounded_policy_parameter_integer_step_update(
                anchor_value=anchor_value,
                gradient_value=gradient_value,
                learning_rate=learning_rate,
                spec=spec,
            )
        else:
            updated = bounded_policy_parameter_value(
                anchor_value + (learning_rate * gradient_value * span),
                spec,
            )
        updated_parameters[name] = updated
        parameter_delta[name] = round_policy_number(float(updated) - anchor_value)

    return_summary = policy_update_return_summary(
        candidates=candidates,
        samples=samples,
        baseline=return_baseline,
    )
    gradient_stability = policy_update_gradient_stability_gate(
        policy_gradient=policy_gradient,
        parameter_space=parameter_space,
        candidates=candidates,
        samples=samples,
        anchor_parameters=anchor_parameters,
        return_baseline=return_baseline,
        gradient=gradient,
        selected_reward_tier_by_parameter=selected_reward_tier_by_parameter,
        gradient_estimation=gradient_estimation,
        gradient_momentum=gradient_momentum,
    )
    parameter_evidence = policy_update_runtime_injection_ready_parameter_evidence(policy_gradient, candidates)
    gradient_stability = policy_update_gradient_stability_with_parameter_evidence(
        gradient_stability,
        parameter_evidence,
    )
    if parameter_evidence.get("policyUpdateEligible") is not True:
        return {
            **base,
            "skippedReason": RUNTIME_PARAMETER_INJECTION_INCOMPLETE_SKIP_REASON,
            "candidateCount": len(candidates),
            "metadataCandidateCount": policy_gradient_candidate_vector_count(policy_gradient),
            "parameterEvidence": parameter_evidence,
            "anchor": policy_update_candidate_summary(anchor),
            "candidateRewards": [policy_update_candidate_summary(row) for row in candidates],
            "learningRate": learning_rate,
            "gradient": gradient,
            "rawGradient": raw_gradient,
            "gradientEstimation": gradient_estimation,
            "gradientMomentum": gradient_momentum,
            "gradientStability": gradient_stability,
            "gradientStable": gradient_stability["gradientStable"],
            "trustedGradientUpdate": False,
            "highVariance": gradient_stability["highVariance"],
            "returnSummary": return_summary,
            "promotionGate": policy_update_promotion_gate(
                parameter_evidence,
                policy_update_generated=False,
                gradient_stability=gradient_stability,
            ),
        }

    if not any(abs(float(value)) > 0 for value in parameter_delta.values()):
        no_change_parameter_evidence = {
            **parameter_evidence,
            "learningRate": learning_rate,
            "boundedIntegerStep": bounded_integer_step,
        }
        return {
            **base,
            "skippedReason": "bounded_update_no_parameter_change",
            "candidateCount": len(candidates),
            "parameterEvidence": no_change_parameter_evidence,
            "anchor": policy_update_candidate_summary(anchor),
            "candidateRewards": [policy_update_candidate_summary(row) for row in candidates],
            "learningRate": learning_rate,
            "boundedIntegerStep": bounded_integer_step,
            "gradient": gradient,
            "rawGradient": raw_gradient,
            "gradientEstimation": gradient_estimation,
            "gradientMomentum": gradient_momentum,
            "gradientStability": gradient_stability,
            "gradientStable": gradient_stability["gradientStable"],
            "trustedGradientUpdate": False,
            "highVariance": gradient_stability["highVariance"],
            "promotionGate": policy_update_promotion_gate(
                parameter_evidence,
                policy_update_generated=False,
                gradient_stability=gradient_stability,
            ),
        }

    candidate_policy_id = updated_candidate_policy_id(
        target_family=target_family,
        report_id=report_id,
        parameters=updated_parameters,
    )
    trusted_gradient_update = gradient_stability["trustedUpdate"] is True
    promotion_gate = policy_update_promotion_gate(
        parameter_evidence,
        policy_update_generated=True,
        gradient_stability=gradient_stability,
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
        "gradientStable": gradient_stability["gradientStable"],
        "trustedGradientUpdate": trusted_gradient_update,
        "highVariance": gradient_stability["highVariance"],
        "gradientEstimation": copy.deepcopy(gradient_estimation),
        "gradientEstimationSchemeKey": gradient_estimation.get("schemeKey"),
        "gradientComparisonKey": gradient_estimation.get("comparisonKey"),
        "gradientEstimationScheme": copy.deepcopy(gradient_estimation.get("schemeIdentity")),
        "gradientMomentum": copy.deepcopy(gradient_momentum),
        "gradientStability": copy.deepcopy(gradient_stability),
        "parameters": updated_parameters,
        "runtimeParameterConsumption": promotion_gate["runtimeParameterConsumption"],
        "runtimeParameterConsumptionStatus": promotion_gate["runtimeParameterConsumptionStatus"],
        "consumptionMode": promotion_gate["consumptionMode"],
        "promotionGate": copy.deepcopy(promotion_gate),
        "parameterEvidence": {
            "derivation": (
                "deterministic REINFORCE score-function estimate from authorized scalar weighted "
                "offline/private/shadow reward returns, preserving lexicographic ranking and promotion gates"
                if scalar_weighted_authorized
                else "deterministic REINFORCE score-function estimate from offline simulator Monte Carlo "
                "reward-tuple returns, selecting the first lexicographic reward tier with per-parameter "
                "evidence and preserving lexicographic ranking/promotion gates"
            ),
            "targetFamily": target_family,
            "learnableKnobs": list(parameter_space),
            "anchorParameters": copy.deepcopy(anchor_parameters),
            "gradient": copy.deepcopy(gradient),
            "rawGradient": copy.deepcopy(raw_gradient),
            "gradientByRewardTier": copy.deepcopy(gradient_by_tier),
            "gradientEstimation": copy.deepcopy(gradient_estimation),
            "gradientMomentum": copy.deepcopy(gradient_momentum),
            "selectedRewardTierByParameter": copy.deepcopy(selected_reward_tier_by_parameter),
            "parameterDelta": copy.deepcopy(parameter_delta),
            "learningRate": learning_rate,
            "boundedIntegerStep": bounded_integer_step,
            "returnBaseline": copy.deepcopy(return_baseline),
            "returnSampleCount": len(samples),
            "candidateCount": len(candidates),
            "policyUpdateAlgorithm": TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM,
            "trueGradient": True,
            "scalarWeightedSumAuthorized": scalar_weighted_authorized,
            "gradientStable": gradient_stability["gradientStable"],
            "trustedGradientUpdate": trusted_gradient_update,
            "highVariance": gradient_stability["highVariance"],
            "gradientStability": copy.deepcopy(gradient_stability),
            "runtimeParameterConsumption": promotion_gate["runtimeParameterConsumption"],
            "runtimeParameterConsumptionStatus": promotion_gate["runtimeParameterConsumptionStatus"],
            "consumptionMode": promotion_gate["consumptionMode"],
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
        "policyGradientEstimator": (
            POLICY_GRADIENT_SCALAR_ESTIMATOR
            if scalar_weighted_authorized
            else POLICY_GRADIENT_LEXICOGRAPHIC_REINFORCE_ESTIMATOR
        ),
        "scalarWeightedSumAuthorized": scalar_weighted_authorized,
        "scalarWeightedSumUse": gradient_estimation.get("scalarWeightedSumUse"),
        "gradientStable": gradient_stability["gradientStable"],
        "trustedGradientUpdate": trusted_gradient_update,
        "highVariance": gradient_stability["highVariance"],
        "learningRate": learning_rate,
        "boundedIntegerStep": bounded_integer_step,
        "parameterSpace": copy.deepcopy(parameter_space),
        "candidateCount": len(candidates),
        "parameterEvidence": parameter_evidence,
        "anchor": policy_update_candidate_summary(anchor),
        "candidateRewards": [policy_update_candidate_summary(row) for row in candidates],
        "returnSummary": return_summary,
        "gradient": gradient,
        "rawGradient": raw_gradient,
        "gradientByRewardTier": gradient_by_tier,
        "gradientEstimation": gradient_estimation,
        "gradientEstimationSchemeKey": gradient_estimation.get("schemeKey"),
        "gradientComparisonKey": gradient_estimation.get("comparisonKey"),
        "gradientEstimationScheme": copy.deepcopy(gradient_estimation.get("schemeIdentity")),
        "gradientMomentum": gradient_momentum,
        "gradientStability": gradient_stability,
        "selectedRewardTierByParameter": selected_reward_tier_by_parameter,
        "parameterDelta": parameter_delta,
        "updatedParameters": updated_parameters,
        "runtimeParameterConsumption": promotion_gate["runtimeParameterConsumption"],
        "runtimeParameterConsumptionStatus": promotion_gate["runtimeParameterConsumptionStatus"],
        "consumptionMode": promotion_gate["consumptionMode"],
        "promotionGate": promotion_gate,
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
        raw_scalar_samples = row.get("scalarReturnSamples")
        scalar_samples = raw_scalar_samples if isinstance(raw_scalar_samples, list) else []
        for sample_index, return_tuple in enumerate(raw_samples):
            if not isinstance(return_tuple, list):
                continue
            sample = {"candidate": row, "returnTuple": return_tuple}
            if sample_index < len(scalar_samples):
                scalar_value = number_or_none(scalar_samples[sample_index])
                if scalar_value is not None:
                    sample["scalarReturn"] = round_policy_number(float(scalar_value))
            samples.append(sample)
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


def policy_update_scalar_gradient_scheme_identity(
    weight_evidence: JsonObject,
    *,
    scalar_weighted_sum_authorized: bool = False,
    scalar_weighted_sum_use: str = POLICY_GRADIENT_SCALAR_WEIGHTED_SUM_USE,
) -> JsonObject:
    return {
        "type": GRADIENT_ESTIMATION_SCHEME_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "estimator": POLICY_GRADIENT_SCALAR_ESTIMATOR,
        "gradientReward": POLICY_GRADIENT_SCALAR_REWARD,
        "gradientUse": "policy_gradient_estimation_only",
        "scalarWeightedSumUse": scalar_weighted_sum_use,
        "rankingRewardModel": POLICY_GRADIENT_LEXICOGRAPHIC_REWARD,
        "rewardComponentOrder": list(SCALAR_WEIGHTED_REWARD_TIERS),
        "lexicographicRankingPreserved": True,
        "scalarWeightedSumAuthorized": scalar_weighted_sum_authorized,
        "normalizedWeightsByRewardTier": copy.deepcopy(weight_evidence["normalizedWeightsByRewardTier"]),
        "normalizationCap": weight_evidence["normalizationCap"],
        "normalizationFactor": weight_evidence["normalizationFactor"],
        "scalarRewardScaleFactor": weight_evidence["scalarRewardScaleFactor"],
    }


def policy_update_lexicographic_reinforce_gradient_scheme_identity() -> JsonObject:
    return {
        "type": GRADIENT_ESTIMATION_SCHEME_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "estimator": POLICY_GRADIENT_LEXICOGRAPHIC_REINFORCE_ESTIMATOR,
        "gradientReward": POLICY_GRADIENT_LEXICOGRAPHIC_PER_TIER_REWARD,
        "gradientUse": "policy_gradient_estimation_only",
        "scalarWeightedSumUse": "not_used",
        "rankingRewardModel": POLICY_GRADIENT_LEXICOGRAPHIC_REWARD,
        "rewardComponentOrder": list(REWARD_TIERS),
        "tierBaseline": POLICY_GRADIENT_LEXICOGRAPHIC_TIER_BASELINE,
        "tierSelection": POLICY_GRADIENT_LEXICOGRAPHIC_TIER_SELECTION,
        "advantageScale": POLICY_GRADIENT_LEXICOGRAPHIC_PAIRWISE_ADVANTAGE_SCALE,
        "lexicographicRankingPreserved": True,
        "scalarWeightedSumAuthorized": False,
    }


def policy_update_lexicographic_gradient_scheme_identity() -> JsonObject:
    return {
        "type": GRADIENT_ESTIMATION_SCHEME_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "estimator": RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM,
        "gradientReward": POLICY_GRADIENT_LEXICOGRAPHIC_REWARD,
        "rankingRewardModel": POLICY_GRADIENT_LEXICOGRAPHIC_REWARD,
        "rewardComponentOrder": list(REWARD_TIERS),
        "scalarWeightedSumUse": "not_used",
        "lexicographicRankingPreserved": True,
        "scalarWeightedSumAuthorized": False,
    }


def policy_update_gradient_scheme_key(identity: JsonObject) -> str:
    return canonical_hash(identity)


GRADIENT_SCHEME_COMPARISON_IDENTITY_FIELDS = (
    "type",
    "schemaVersion",
    "estimator",
    "gradientReward",
    "gradientUse",
    "scalarWeightedSumUse",
    "rankingRewardModel",
    "rewardComponentOrder",
    "tierBaseline",
    "tierSelection",
    "advantageScale",
    "lexicographicRankingPreserved",
    "scalarWeightedSumAuthorized",
    "normalizedWeightsByRewardTier",
    "normalizationCap",
    "scalarRewardScaleFactor",
)


def policy_update_gradient_scheme_comparison_identity(identity: JsonObject) -> JsonObject:
    return {
        field: copy.deepcopy(identity[field])
        for field in GRADIENT_SCHEME_COMPARISON_IDENTITY_FIELDS
        if field in identity
    }


def policy_update_gradient_scheme_comparison_key(identity: JsonObject) -> str:
    estimator = text_or_none(identity.get("estimator")) or "unknown-estimator"
    return f"{estimator}:{canonical_hash(policy_update_gradient_scheme_comparison_identity(identity))}"


def policy_update_gradient_scheme_identity_from_evidence(raw: Any) -> JsonObject | None:
    if not isinstance(raw, dict):
        return None
    scheme_identity = first_mapping(raw, ("schemeIdentity", "gradientSchemeIdentity", "gradientEstimationScheme"))
    if scheme_identity is not None:
        return copy.deepcopy(scheme_identity)

    estimator = text_or_none(raw.get("estimator"))
    gradient_reward = text_or_none(raw.get("gradientReward", raw.get("gradient_reward")))
    ranking_reward = text_or_none(raw.get("rankingRewardModel", raw.get("ranking_reward_model")))
    if estimator is None and gradient_reward is None and ranking_reward is None:
        return None

    identity: JsonObject = {
        "type": GRADIENT_ESTIMATION_SCHEME_TYPE,
        "schemaVersion": SCHEMA_VERSION,
    }
    if estimator is not None:
        identity["estimator"] = estimator
    if gradient_reward is not None:
        identity["gradientReward"] = gradient_reward
    if ranking_reward is not None:
        identity["rankingRewardModel"] = ranking_reward
    for source_key, dest_key in (
        ("gradientUse", "gradientUse"),
        ("scalarWeightedSumUse", "scalarWeightedSumUse"),
        ("lexicographicRankingPreserved", "lexicographicRankingPreserved"),
        ("scalarWeightedSumAuthorized", "scalarWeightedSumAuthorized"),
        ("normalizedWeightsByRewardTier", "normalizedWeightsByRewardTier"),
        ("normalizationCap", "normalizationCap"),
        ("normalizationFactor", "normalizationFactor"),
        ("scalarRewardScaleFactor", "scalarRewardScaleFactor"),
        ("tierBaseline", "tierBaseline"),
        ("tierSelection", "tierSelection"),
        ("advantageScale", "advantageScale"),
    ):
        if source_key in raw:
            identity[dest_key] = copy.deepcopy(raw[source_key])
    component_order = raw.get("rewardComponentOrder") or raw.get("componentOrder")
    if isinstance(component_order, list):
        identity["rewardComponentOrder"] = copy.deepcopy(component_order)
    return identity


def policy_update_gradient_state_config_candidates(policy_gradient: JsonObject) -> list[JsonObject]:
    configs: list[JsonObject] = []
    for raw in policy_update_config_candidates(policy_gradient):
        configs.append(raw)
        for key in ("gradient_momentum", "gradientMomentum", "gradient_ema", "gradientEma"):
            nested = raw.get(key)
            if isinstance(nested, dict):
                configs.append(nested)
    return configs


def policy_update_previous_gradient_scheme_config(policy_gradient: JsonObject) -> JsonObject:
    previous_identity: JsonObject | None = None
    previous_key: str | None = None
    previous_comparison_key: str | None = None
    for raw in policy_update_gradient_state_config_candidates(policy_gradient):
        round_tripped_momentum = text_or_none(raw.get("type")) == GRADIENT_MOMENTUM_EVIDENCE_TYPE
        identity_keys = (
            (
                "previous_gradient_estimation_scheme",
                "previousGradientEstimationScheme",
                "previous_gradient_scheme",
                "previousGradientScheme",
                "previousGradientSchemeIdentity",
                "gradientEstimationScheme",
                "gradientSchemeIdentity",
                "schemeIdentity",
            )
            if round_tripped_momentum
            else (
                "previous_gradient_estimation_scheme",
                "previousGradientEstimationScheme",
                "previous_gradient_scheme",
                "previousGradientScheme",
                "gradientEstimationScheme",
                "schemeIdentity",
            )
        )
        for key in identity_keys:
            identity = first_mapping(raw, (key,))
            if identity is not None:
                previous_identity = copy.deepcopy(identity)
        for key in (
            "previous_gradient_estimation",
            "previousGradientEstimation",
            "gradientEstimation",
        ):
            evidence = first_mapping(raw, (key,))
            identity = policy_update_gradient_scheme_identity_from_evidence(evidence)
            if identity is not None:
                previous_identity = identity
            if isinstance(evidence, dict):
                evidence_comparison_key = text_or_none(
                    first_non_null_present(
                        evidence,
                        (
                            "comparisonKey",
                            "trustedComparisonKey",
                            "gradientComparisonKey",
                            "gradientEstimationComparisonKey",
                        ),
                    )
                )
                if evidence_comparison_key is not None:
                    previous_comparison_key = evidence_comparison_key
                evidence_key = text_or_none(
                    first_non_null_present(
                        evidence,
                        (
                            "schemeKey",
                            "gradientSchemeKey",
                            "gradientEstimationSchemeKey",
                        ),
                    )
                )
                if evidence_key is not None:
                    previous_key = evidence_key
        raw_key = text_or_none(
            first_non_null_present(
                raw,
                (
                    "gradientEstimationSchemeKey",
                    "gradientSchemeKey",
                    "schemeKey",
                    "previous_gradient_estimation_scheme_key",
                    "previousGradientEstimationSchemeKey",
                    "previous_gradient_scheme_key",
                    "previousGradientSchemeKey",
                )
                if round_tripped_momentum
                else (
                    "previous_gradient_estimation_scheme_key",
                    "previousGradientEstimationSchemeKey",
                    "previous_gradient_scheme_key",
                    "previousGradientSchemeKey",
                    "gradientEstimationSchemeKey",
                    "gradientSchemeKey",
                    "schemeKey",
                ),
            )
        )
        if raw_key is not None:
            previous_key = raw_key
        raw_comparison_key = text_or_none(
            first_non_null_present(
                raw,
                (
                    "gradientEstimationComparisonKey",
                    "gradientComparisonKey",
                    "comparisonKey",
                    "trustedComparisonKey",
                    "previous_gradient_estimation_comparison_key",
                    "previousGradientEstimationComparisonKey",
                    "previous_gradient_comparison_key",
                    "previousGradientComparisonKey",
                )
                if round_tripped_momentum
                else (
                    "previous_gradient_estimation_comparison_key",
                    "previousGradientEstimationComparisonKey",
                    "previous_gradient_comparison_key",
                    "previousGradientComparisonKey",
                    "gradientEstimationComparisonKey",
                    "gradientComparisonKey",
                    "comparisonKey",
                    "trustedComparisonKey",
                ),
            )
        )
        if raw_comparison_key is not None:
            previous_comparison_key = raw_comparison_key
    if previous_identity is not None:
        previous_key = policy_update_gradient_scheme_key(previous_identity)
        previous_comparison_key = policy_update_gradient_scheme_comparison_key(previous_identity)
    return {
        "previousGradientSchemeIdentity": previous_identity,
        "previousGradientSchemeKey": previous_key,
        "previousGradientComparisonKey": previous_comparison_key,
    }


def mean_policy_return_tuple(return_tuples: Sequence[Sequence[Any]]) -> list[float | int]:
    if not return_tuples:
        return [0 for _tier in REWARD_TIERS]
    columns = list(zip(*return_tuples))
    return [round_policy_number(statistics.fmean(float(value) for value in column)) for column in columns]


def policy_update_candidate_return_baseline(row: JsonObject) -> list[float | int]:
    mean_return = policy_return_tuple_from_sequence(row.get("meanReturn"))
    if mean_return is not None:
        return mean_return
    raw_samples = row.get("returnSamples")
    if isinstance(raw_samples, list):
        samples = [
            sample
            for raw_sample in raw_samples
            for sample in [policy_return_tuple_from_sequence(raw_sample)]
            if sample is not None
        ]
        if samples:
            return mean_policy_return_tuple(samples)
    reward_tuple = policy_return_tuple_from_sequence(row.get("rewardTuple"))
    if reward_tuple is not None:
        return reward_tuple
    return [0 for _tier in REWARD_TIERS]


def policy_update_lexicographic_reinforce_gradient_estimation(
    *,
    policy_gradient: JsonObject,
    parameter_space: dict[str, JsonObject],
    samples: Sequence[JsonObject],
    anchor_parameters: JsonObject,
    anchor_return_baseline: Sequence[float | int],
) -> JsonObject:
    del policy_gradient
    scheme_identity = policy_update_lexicographic_reinforce_gradient_scheme_identity()
    scheme_key = policy_update_gradient_scheme_key(scheme_identity)
    gradient: JsonObject = {}
    cap_normalized_gradient: JsonObject = {}
    gradient_by_tier: JsonObject = {}
    raw_gradient_by_tier: JsonObject = {}
    tier_evidence_by_parameter: JsonObject = {}
    selected_reward_tier_by_parameter: JsonObject = {}
    direction_by_parameter: JsonObject = {}

    for name, spec in parameter_space.items():
        span = max(float(spec["max"]) - float(spec["min"]), 1.0)
        anchor_value = float(anchor_parameters[name])
        tier_raw_gradients: JsonObject = {}
        tier_rounded_gradients: JsonObject = {}
        tier_evidence: JsonObject = {}
        for tier_index, tier in enumerate(REWARD_TIERS):
            raw_gradient = 0.0
            contribution_sum = 0.0
            positive_count = 0
            negative_count = 0
            zero_count = 0
            baseline_value = (
                float(anchor_return_baseline[tier_index])
                if tier_index < len(anchor_return_baseline)
                else 0.0
            )
            for sample in samples:
                row = sample["candidate"]
                normalized_delta = (float(row["parameters"][name]) - anchor_value) / span
                return_tuple = sample["returnTuple"]
                tier_return = float(return_tuple[tier_index]) if tier_index < len(return_tuple) else 0.0
                advantage = tier_return - baseline_value
                advantage *= POLICY_GRADIENT_LEXICOGRAPHIC_PAIRWISE_ADVANTAGE_SCALE
                contribution = advantage * normalized_delta
                raw_gradient += contribution
                contribution_sum += contribution
                if contribution > 1e-12:
                    positive_count += 1
                elif contribution < -1e-12:
                    negative_count += 1
                else:
                    zero_count += 1
            estimate = raw_gradient / len(samples) if samples else 0.0
            rounded_estimate = round_policy_number(estimate)
            nonzero_count = positive_count + negative_count
            dominant_count = max(positive_count, negative_count)
            dominant_ratio = 1.0 if nonzero_count == 0 else dominant_count / nonzero_count
            tier_raw_gradients[tier] = estimate
            tier_rounded_gradients[tier] = rounded_estimate
            tier_evidence[tier] = {
                "rewardTier": tier,
                "gradient": rounded_estimate,
                "rawGradient": estimate,
                "anchorReturnBaseline": round_policy_number(baseline_value),
                "contributionSum": round_policy_number(contribution_sum),
                "positiveContributionCount": positive_count,
                "negativeContributionCount": negative_count,
                "zeroContributionCount": zero_count,
                "nonZeroContributionCount": nonzero_count,
                "dominantDirectionRatio": round_policy_number(dominant_ratio),
            }

        selected_tier, selected_rounded_gradient = first_nonzero_tier_gradient(tier_rounded_gradients)
        selected_gradient = (
            tier_raw_gradients.get(selected_tier, selected_rounded_gradient)
            if selected_tier is not None
            else 0
        )
        selected_reward_tier_by_parameter[name] = selected_tier
        gradient[name] = selected_gradient
        cap_normalized_gradient[name] = round_policy_number(selected_gradient)
        gradient_by_tier[name] = tier_rounded_gradients
        raw_gradient_by_tier[name] = tier_raw_gradients
        tier_evidence_by_parameter[name] = tier_evidence
        selected_evidence = (
            copy.deepcopy(tier_evidence[selected_tier])
            if selected_tier is not None
            else {
                "rewardTier": None,
                "gradient": 0,
                "rawGradient": 0,
                "anchorReturnBaseline": None,
                "contributionSum": 0,
                "positiveContributionCount": 0,
                "negativeContributionCount": 0,
                "zeroContributionCount": len(samples),
                "nonZeroContributionCount": 0,
                "dominantDirectionRatio": 1,
            }
        )
        selected_evidence.update(
            {
                "gradientReward": POLICY_GRADIENT_LEXICOGRAPHIC_PER_TIER_REWARD,
                "selectedRewardTier": selected_tier,
                "gradientByRewardTier": copy.deepcopy(tier_rounded_gradients),
                "rawGradientByRewardTier": copy.deepcopy(tier_raw_gradients),
            }
        )
        direction_by_parameter[name] = selected_evidence

    return {
        "type": GRADIENT_ESTIMATION_EVIDENCE_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "estimator": POLICY_GRADIENT_LEXICOGRAPHIC_REINFORCE_ESTIMATOR,
        "gradientReward": POLICY_GRADIENT_LEXICOGRAPHIC_PER_TIER_REWARD,
        "gradientUse": "policy_gradient_estimation_only",
        "scalarWeightedSumUse": "not_used",
        "rankingRewardModel": POLICY_GRADIENT_LEXICOGRAPHIC_REWARD,
        "rewardComponentOrder": list(REWARD_TIERS),
        "tierBaseline": POLICY_GRADIENT_LEXICOGRAPHIC_TIER_BASELINE,
        "tierSelection": POLICY_GRADIENT_LEXICOGRAPHIC_TIER_SELECTION,
        "advantageScale": POLICY_GRADIENT_LEXICOGRAPHIC_PAIRWISE_ADVANTAGE_SCALE,
        "lexicographicRankingPreserved": True,
        "scalarWeightedSumAuthorized": False,
        "schemeIdentity": scheme_identity,
        "schemeKey": scheme_key,
        "comparisonKey": policy_update_gradient_scheme_comparison_key(scheme_identity),
        "trustedComparisonKey": policy_update_gradient_scheme_comparison_key(scheme_identity),
        "returnBaseline": [round_policy_number(float(value)) for value in anchor_return_baseline],
        "returnBaselineType": POLICY_GRADIENT_LEXICOGRAPHIC_TIER_BASELINE,
        "gradient": gradient,
        "capNormalizedGradient": cap_normalized_gradient,
        "gradientByRewardTier": gradient_by_tier,
        "rawGradientByRewardTier": raw_gradient_by_tier,
        "tierEvidenceByParameter": tier_evidence_by_parameter,
        "selectedRewardTierByParameter": selected_reward_tier_by_parameter,
        "sampleCount": len(samples),
        "directionByParameter": direction_by_parameter,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }


def policy_update_scalar_weighted_gradient_estimation(
    *,
    policy_gradient: JsonObject,
    parameter_space: dict[str, JsonObject],
    samples: Sequence[JsonObject],
    anchor_parameters: JsonObject,
) -> JsonObject:
    weight_evidence = policy_update_scalar_reward_weight_evidence(policy_gradient)
    scalar_authorized = policy_gradient_scalar_weighted_sum_authorized(policy_gradient)
    scalar_use = (
        scalar_weighted_sum_use(first_mapping(policy_gradient, ("reward_model", "rewardModel")))
        if scalar_authorized
        else POLICY_GRADIENT_SCALAR_WEIGHTED_SUM_USE
    )
    scheme_identity = policy_update_scalar_gradient_scheme_identity(
        weight_evidence,
        scalar_weighted_sum_authorized=scalar_authorized,
        scalar_weighted_sum_use=scalar_use,
    )
    scheme_key = policy_update_gradient_scheme_key(scheme_identity)
    weights = weight_evidence["normalizedWeightsByRewardTier"]
    scalar_returns = [
        float(scalar_return)
        if (scalar_return := number_or_none(sample.get("scalarReturn"))) is not None
        else policy_update_scalar_reward(sample["returnTuple"], weights)
        for sample in samples
    ]
    scalar_baseline = statistics.fmean(scalar_returns) if scalar_returns else 0.0
    gradient: JsonObject = {}
    cap_normalized_gradient: JsonObject = {}
    direction_by_parameter: JsonObject = {}

    for name, spec in parameter_space.items():
        span = max(float(spec["max"]) - float(spec["min"]), 1.0)
        anchor_value = float(anchor_parameters[name])
        raw_gradient = 0.0
        contribution_sum = 0.0
        positive_count = 0
        negative_count = 0
        zero_count = 0
        for sample, scalar_return in zip(samples, scalar_returns):
            row = sample["candidate"]
            normalized_delta = (float(row["parameters"][name]) - anchor_value) / span
            advantage = scalar_return - scalar_baseline
            contribution = advantage * normalized_delta
            raw_gradient += contribution
            contribution_sum += contribution
            if contribution > 1e-12:
                positive_count += 1
            elif contribution < -1e-12:
                negative_count += 1
            else:
                zero_count += 1
        nonzero_count = positive_count + negative_count
        dominant_count = max(positive_count, negative_count)
        dominant_ratio = 1.0 if nonzero_count == 0 else dominant_count / nonzero_count
        cap_normalized_estimate = raw_gradient / len(samples) if samples else 0
        cap_normalized_gradient[name] = round_policy_number(cap_normalized_estimate)
        gradient[name] = cap_normalized_estimate
        direction_by_parameter[name] = {
            "gradientReward": POLICY_GRADIENT_SCALAR_REWARD,
            "gradient": cap_normalized_gradient[name],
            "contributionSum": round_policy_number(contribution_sum),
            "capNormalizedContributionSum": round_policy_number(contribution_sum),
            "positiveContributionCount": positive_count,
            "negativeContributionCount": negative_count,
            "zeroContributionCount": zero_count,
            "nonZeroContributionCount": nonzero_count,
            "dominantDirectionRatio": round_policy_number(dominant_ratio),
        }

    return {
        "type": GRADIENT_ESTIMATION_EVIDENCE_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "estimator": POLICY_GRADIENT_SCALAR_ESTIMATOR,
        "gradientReward": POLICY_GRADIENT_SCALAR_REWARD,
        "gradientUse": "policy_gradient_estimation_only",
        "scalarWeightedSumUse": scalar_use,
        "rankingRewardModel": POLICY_GRADIENT_LEXICOGRAPHIC_REWARD,
        "rewardComponentOrder": list(SCALAR_WEIGHTED_REWARD_TIERS),
        "lexicographicRankingPreserved": True,
        "scalarWeightedSumAuthorized": scalar_authorized,
        "schemeIdentity": scheme_identity,
        "schemeKey": scheme_key,
        "comparisonKey": policy_update_gradient_scheme_comparison_key(scheme_identity),
        "trustedComparisonKey": policy_update_gradient_scheme_comparison_key(scheme_identity),
        "sourceComponentWeights": weight_evidence["sourceComponentWeights"],
        "normalizedWeightsByRewardTier": weights,
        "sourceMaxComponentWeight": weight_evidence["sourceMaxComponentWeight"],
        "normalizationCap": weight_evidence["normalizationCap"],
        "normalizationFactor": weight_evidence["normalizationFactor"],
        "scalarRewardScaleFactor": weight_evidence["scalarRewardScaleFactor"],
        "scalarReturns": [round_policy_number(value) for value in scalar_returns],
        "gradient": gradient,
        "capNormalizedGradient": cap_normalized_gradient,
        "scalarReturnBaseline": round_policy_number(scalar_baseline),
        "capNormalizedScalarReturnBaseline": round_policy_number(scalar_baseline),
        "sampleCount": len(samples),
        "directionByParameter": direction_by_parameter,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }


def policy_update_scalar_reward_weight_evidence(policy_gradient: JsonObject) -> JsonObject:
    source_weights = dict(DEFAULT_POLICY_GRADIENT_SCALAR_COMPONENT_WEIGHTS)
    for raw in policy_update_config_candidates(policy_gradient):
        reward_model = first_mapping(raw, ("reward_model", "rewardModel"))
        if reward_model is not None:
            component_weights = first_mapping(reward_model, ("component_weights", "componentWeights"))
            if component_weights is not None:
                source_weights.update(policy_update_component_weights_by_tier(component_weights))
            scalar_config = first_mapping(reward_model, ("scalar_weighted_sum", "scalarWeightedSum"))
            if scalar_config is not None:
                scalar_component_weights = first_mapping(scalar_config, ("component_weights", "componentWeights"))
                if scalar_component_weights is not None:
                    source_weights.update(policy_update_component_weights_by_tier(scalar_component_weights))
        component_weights = first_mapping(
            raw,
            (
                "gradient_reward_weights",
                "gradientRewardWeights",
                "scalar_reward_weights",
                "scalarRewardWeights",
            ),
        )
        if component_weights is not None:
            source_weights.update(policy_update_component_weights_by_tier(component_weights))

    max_source_weight = max(max(abs(value) for value in source_weights.values()), 1.0)
    normalization_factor = min(
        max_source_weight,
        DEFAULT_POLICY_GRADIENT_SCALAR_WEIGHT_NORMALIZATION_CAP,
    )
    scalar_reward_scale_factor = normalization_factor / max_source_weight
    weight_tiers = [tier for tier in SCALAR_WEIGHTED_REWARD_TIERS if tier in source_weights]
    normalized = {
        tier: source_weights[tier] / normalization_factor
        for tier in weight_tiers
    }
    return {
        "sourceComponentWeights": {tier: round_policy_number(source_weights[tier]) for tier in weight_tiers},
        "normalizedWeightsByRewardTier": normalized,
        "sourceMaxComponentWeight": round_policy_number(max_source_weight),
        "normalizationCap": round_policy_number(
            DEFAULT_POLICY_GRADIENT_SCALAR_WEIGHT_NORMALIZATION_CAP
        ),
        "normalizationFactor": round_policy_number(normalization_factor),
        "scalarRewardScaleFactor": scalar_reward_scale_factor,
    }


def policy_update_component_weights_by_tier(raw: JsonObject) -> dict[str, float]:
    aliases = {
        "reliability": ("reliability", "alpha_reliability", "alphaReliability", "reliabilityWeight"),
        "territory": ("territory", "beta_territory", "betaTerritory", "territoryWeight"),
        "resources": ("resources", "gamma_resources", "gammaResources", "resourcesWeight"),
        "kills": ("kills", "delta_kills", "deltaKills", "killsWeight"),
        "activation": ("activation", "epsilon_activation", "epsilonActivation", "activationWeight"),
    }
    weights: dict[str, float] = {}
    for tier, names in aliases.items():
        for name in names:
            value = number_or_none(raw.get(name))
            if value is not None and math.isfinite(float(value)) and float(value) > 0:
                weights[tier] = float(value)
                break
    return weights


def policy_update_scalar_reward(return_tuple: Sequence[Any], weights: JsonObject) -> float:
    total = 0.0
    for index, tier in enumerate(SCALAR_WEIGHTED_REWARD_TIERS):
        if index >= len(return_tuple):
            continue
        total += float(return_tuple[index]) * float(weights.get(tier, 0))
    return total


def policy_update_expected_true_gradient_scheme_identity(policy_gradient: JsonObject) -> JsonObject | None:
    if policy_update_algorithm(policy_gradient) != TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM:
        return None
    if policy_gradient_scalar_weighted_sum_authorized(policy_gradient):
        reward_model = first_mapping(policy_gradient, ("reward_model", "rewardModel"))
        return policy_update_scalar_gradient_scheme_identity(
            policy_update_scalar_reward_weight_evidence(policy_gradient),
            scalar_weighted_sum_authorized=True,
            scalar_weighted_sum_use=scalar_weighted_sum_use(reward_model),
        )
    return policy_update_lexicographic_reinforce_gradient_scheme_identity()


def policy_update_gradient_momentum_state_identity(policy_gradient: JsonObject) -> JsonObject | None:
    scheme_identity = policy_update_expected_true_gradient_scheme_identity(policy_gradient)
    if scheme_identity is None:
        return None
    target_family = text_or_none(policy_gradient.get("target_family", policy_gradient.get("targetFamily"))) or "unknown"
    return {
        "type": GRADIENT_MOMENTUM_STATE_IDENTITY_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "targetFamily": target_family,
        "policyUpdateAlgorithm": TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM,
        "gradientComparisonKey": policy_update_gradient_scheme_comparison_key(scheme_identity),
        "gradientSchemeIdentity": policy_update_gradient_scheme_comparison_identity(scheme_identity),
        "learnableParameters": copy.deepcopy(policy_update_parameter_space(policy_gradient)),
    }


def policy_update_gradient_momentum_state_key(identity: JsonObject) -> str:
    return canonical_hash(identity)


def policy_update_gradient_momentum_state_path(policy_gradient: JsonObject, out_dir: Path) -> Path | None:
    identity = policy_update_gradient_momentum_state_identity(policy_gradient)
    if identity is None:
        return None
    target_family = safe_artifact_stem(text_or_none(identity.get("targetFamily")) or "unknown")[:80]
    state_key = policy_update_gradient_momentum_state_key(identity)
    return out_dir / GRADIENT_MOMENTUM_STATE_ARTIFACT_DIR / f"{target_family}-{state_key[:16]}.json"


def policy_update_gradient_momentum_state_payload_hash(payload: JsonObject) -> str:
    return canonical_hash({key: value for key, value in payload.items() if key != "statePayloadHash"})


def policy_update_gradient_momentum_state_reference(policy_gradient: JsonObject, out_dir: Path) -> JsonObject | None:
    identity = policy_update_gradient_momentum_state_identity(policy_gradient)
    if identity is None:
        return None
    state_path = policy_update_gradient_momentum_state_path(policy_gradient, out_dir)
    if state_path is None:
        return None
    return {
        "type": GRADIENT_MOMENTUM_STATE_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "stateIdentity": identity,
        "stateKey": policy_update_gradient_momentum_state_key(identity),
        "stateArtifactPath": dataset_export.display_path(state_path),
        "previousStateArtifactPresent": state_path.exists(),
        "previousStateArtifactLoaded": False,
        "previousGradientPresent": False,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }


def policy_update_gradient_momentum_from_state_payload(raw: Any) -> JsonObject | None:
    if not isinstance(raw, dict):
        return None
    if text_or_none(raw.get("type")) == GRADIENT_MOMENTUM_EVIDENCE_TYPE:
        return copy.deepcopy(raw)
    momentum = first_mapping(raw, ("gradientMomentum", "gradient_momentum", "momentum"))
    return copy.deepcopy(momentum) if momentum is not None else None


def resolve_policy_gradient_momentum_source_report_path(raw_path: str, out_dir: Path) -> Path:
    source_path = Path(raw_path).expanduser()
    if source_path.is_absolute():
        return source_path

    candidates = [source_path, out_dir / source_path, out_dir / source_path.name]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return source_path


def policy_gradient_momentum_state_source_report_load_error(raw_payload: JsonObject, out_dir: Path) -> str | None:
    source_report_path_text = text_or_none(raw_payload.get("sourceReportPath"))
    if source_report_path_text is None:
        return "gradient momentum state source report path was missing or invalid"

    source_report_id = text_or_none(first_non_null_present(raw_payload, ("sourceReportId", "reportId")))
    source_report_generated_at = text_or_none(
        first_non_null_present(raw_payload, ("sourceReportGeneratedAt", "generatedAt"))
    )
    if source_report_id is None or source_report_generated_at is None:
        return "gradient momentum state source report identity was missing or invalid"

    source_report_path = resolve_policy_gradient_momentum_source_report_path(source_report_path_text, out_dir)
    if not source_report_path.exists():
        return "gradient momentum state source report was missing"

    try:
        source_report = json.loads(source_report_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        return f"gradient momentum state source report could not be read: {dataset_export.redact_text(str(error))}"
    if not isinstance(source_report, dict):
        return "gradient momentum state source report was not a JSON object"

    if (
        text_or_none(source_report.get("reportId")) != source_report_id
        or text_or_none(source_report.get("generatedAt")) != source_report_generated_at
    ):
        return "gradient momentum state source report identity did not match state artifact"
    return None


def load_policy_gradient_momentum_state(policy_gradient: JsonObject | None, out_dir: Path) -> JsonObject | None:
    if not isinstance(policy_gradient, dict):
        return None
    state_reference = policy_update_gradient_momentum_state_reference(policy_gradient, out_dir)
    state_path = policy_update_gradient_momentum_state_path(policy_gradient, out_dir)
    if state_reference is None or state_path is None or not state_path.exists():
        return state_reference

    try:
        state_bytes = state_path.read_bytes()
        raw_payload = json.loads(state_bytes.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        state_reference["previousStateArtifactLoadError"] = dataset_export.redact_text(str(error))
        return state_reference
    if not isinstance(raw_payload, dict):
        state_reference["previousStateArtifactLoadError"] = "gradient momentum state artifact was not a JSON object"
        return state_reference
    state_payload_hash = policy_update_gradient_momentum_state_payload_hash(raw_payload)
    stored_payload_hash = raw_payload.get("statePayloadHash")
    if not isinstance(stored_payload_hash, str) or not stored_payload_hash:
        state_reference["previousStateArtifactLoadError"] = "gradient momentum state payload hash was missing or invalid"
        return state_reference
    if stored_payload_hash != state_payload_hash:
        state_reference["previousStateArtifactLoadError"] = "gradient momentum state payload hash did not match artifact contents"
        return state_reference

    stored_identity = first_mapping(raw_payload, ("stateIdentity", "gradientMomentumStateIdentity"))
    stored_key = text_or_none(raw_payload.get("stateKey"))
    expected_key = text_or_none(state_reference.get("stateKey"))
    if stored_identity is not None:
        stored_key = policy_update_gradient_momentum_state_key(stored_identity)
    if stored_key is not None and expected_key is not None and stored_key != expected_key:
        state_reference["previousStateArtifactLoadError"] = "gradient momentum state identity did not match current policy-gradient comparison"
        return state_reference

    source_report_load_error = policy_gradient_momentum_state_source_report_load_error(raw_payload, out_dir)
    if source_report_load_error is not None:
        state_reference["previousStateArtifactLoadError"] = source_report_load_error
        return state_reference

    gradient_momentum = policy_update_gradient_momentum_from_state_payload(raw_payload)
    if gradient_momentum is None:
        state_reference["previousStateArtifactLoadError"] = "gradient momentum state artifact did not contain momentum evidence"
        return state_reference

    previous_gradient = first_present(gradient_momentum, ("rawEmaGradient", "emaGradient"))
    previous_gradient_present = isinstance(previous_gradient, dict) and bool(previous_gradient)
    state_reference.update(
        {
            "previousStateArtifactLoaded": True,
            "previousGradientPresent": previous_gradient_present,
            "previousGradientSourcePath": dataset_export.display_path(state_path),
            "previousGradientSourceSha256": state_payload_hash,
            "previousGradientSourceReportId": text_or_none(
                first_non_null_present(raw_payload, ("sourceReportId", "reportId"))
            ),
            "previousGradientSourceGeneratedAt": text_or_none(
                first_non_null_present(raw_payload, ("sourceReportGeneratedAt", "generatedAt"))
            ),
            "previousTrustedGradientUpdate": raw_payload.get("sourceTrustedGradientUpdate"),
            "previousGradientTrustGateClassification": text_or_none(
                raw_payload.get("sourceGradientTrustGateClassification")
            ),
            "gradientMomentum": gradient_momentum,
        }
    )
    return state_reference


def policy_update_gradient_momentum_state_reference_config(state_reference: JsonObject) -> JsonObject:
    payload: JsonObject = {}
    for key in (
        "stateArtifactPath",
        "stateKey",
        "stateIdentity",
        "previousStateArtifactPresent",
        "previousStateArtifactLoaded",
        "previousStateArtifactLoadError",
        "previousGradientSourcePath",
        "previousGradientSourceSha256",
        "previousGradientSourceReportId",
        "previousGradientSourceGeneratedAt",
        "previousTrustedGradientUpdate",
        "previousGradientTrustGateClassification",
    ):
        if key in state_reference:
            payload[key] = copy.deepcopy(state_reference[key])
    return payload


def policy_gradient_with_loaded_gradient_momentum_state(
    policy_gradient: JsonObject,
    state_reference: JsonObject,
) -> JsonObject:
    payload = copy.deepcopy(policy_gradient)
    update_config = first_mapping(payload, ("policyUpdate", "policy_update"))
    if update_config is None:
        update_config = {}
        payload["policyUpdate"] = update_config
    existing_momentum = first_mapping(update_config, ("gradientMomentum", "gradient_momentum"))
    loaded_momentum = first_mapping(state_reference, ("gradientMomentum",))
    decay_fields = ("ema_decay", "emaDecay", "momentum", "momentumDecay", "gradient_ema_decay", "gradientEmaDecay")
    configured_decay = first_non_null_present(update_config, decay_fields)
    if existing_momentum is not None:
        nested_decay = first_non_null_present(existing_momentum, decay_fields)
        if nested_decay is not None:
            configured_decay = nested_decay
    momentum_config = copy.deepcopy(existing_momentum) if existing_momentum is not None else {}
    if loaded_momentum is not None:
        momentum_config.update(copy.deepcopy(loaded_momentum))
    if configured_decay is not None:
        momentum_config["emaDecay"] = copy.deepcopy(configured_decay)
    momentum_config.update(policy_update_gradient_momentum_state_reference_config(state_reference))
    update_config["gradientMomentum"] = momentum_config
    return payload


def policy_update_gradient_momentum_evidence(
    *,
    policy_gradient: JsonObject,
    raw_gradient: JsonObject,
    gradient_estimation: JsonObject | None = None,
) -> JsonObject:
    config = policy_update_gradient_momentum_config(policy_gradient)
    decay = float(config["emaDecay"])
    configured_previous_gradient = config["previousEmaGradient"]
    current_scheme_identity = policy_update_gradient_scheme_identity_from_evidence(gradient_estimation)
    current_scheme_key = (
        policy_update_gradient_scheme_key(current_scheme_identity)
        if current_scheme_identity is not None
        else None
    )
    current_comparison_key = (
        policy_update_gradient_scheme_comparison_key(current_scheme_identity)
        if current_scheme_identity is not None
        else None
    )
    previous_scheme_identity = config.get("previousGradientSchemeIdentity")
    previous_scheme_key = text_or_none(config.get("previousGradientSchemeKey"))
    previous_comparison_key = text_or_none(config.get("previousGradientComparisonKey"))
    configured_previous_gradient_present = bool(configured_previous_gradient)
    if not configured_previous_gradient_present:
        gradient_scheme_compatible = True
        scheme_status = "current_scheme_only"
    elif current_comparison_key is None:
        gradient_scheme_compatible = True
        scheme_status = "current_scheme_unavailable"
    elif previous_comparison_key is None and previous_scheme_key is None:
        gradient_scheme_compatible = False
        scheme_status = "previous_scheme_missing"
    elif (
        previous_comparison_key == current_comparison_key
        or (previous_comparison_key is None and previous_scheme_key == current_scheme_key)
    ):
        gradient_scheme_compatible = True
        scheme_status = "same_scheme"
    else:
        gradient_scheme_compatible = False
        scheme_status = "scheme_mismatch"
    previous_gradient = configured_previous_gradient if gradient_scheme_compatible else {}
    ema_gradient: JsonObject = {}
    raw_ema_gradient: JsonObject = {}
    conflicting_parameters: list[str] = []
    direction_by_parameter: JsonObject = {}
    raw_vs_momentum_direction_by_parameter: JsonObject = {}
    for name, value in raw_gradient.items():
        raw_value = float(value)
        previous_present = name in previous_gradient
        previous_value = float(previous_gradient.get(name, raw_value))
        ema_value = (decay * previous_value) + ((1.0 - decay) * raw_value) if previous_present else raw_value
        raw_sign = policy_gradient_direction_sign(raw_value)
        previous_sign = policy_gradient_direction_sign(previous_value) if previous_present else raw_sign
        ema_sign = policy_gradient_direction_sign(ema_value)
        direction_consistent = not (
            previous_present
            and raw_sign != 0
            and previous_sign != 0
            and raw_sign != previous_sign
        )
        ema_consistent = not (raw_sign != 0 and ema_sign != 0 and raw_sign != ema_sign)
        momentum_consistent = direction_consistent and ema_consistent
        if not momentum_consistent:
            conflicting_parameters.append(str(name))
        raw_ema_gradient[name] = ema_value
        rounded_ema_value = round_policy_number(ema_value)
        ema_gradient[name] = rounded_ema_value
        direction_by_parameter[name] = {
            "rawGradient": round_policy_number(raw_value),
            "previousEmaGradient": round_policy_number(previous_value) if previous_present else None,
            "emaGradient": rounded_ema_value,
            "previousGradientPresent": previous_present,
            "rawDirection": raw_sign,
            "previousDirection": previous_sign if previous_present else None,
            "emaDirection": ema_sign,
            "momentumConsistent": momentum_consistent,
        }
        raw_vs_momentum_direction_by_parameter[name] = {
            "rawGradient": round_policy_number(raw_value),
            "momentumAdjustedGradient": rounded_ema_value,
            "rawDirection": raw_sign,
            "momentumAdjustedDirection": ema_sign,
            "directionChanged": raw_sign != ema_sign,
        }

    previous_gradient_present = bool(previous_gradient)
    previous_gradient_used = any(
        isinstance(evidence, dict) and evidence.get("previousGradientPresent") is True
        for evidence in direction_by_parameter.values()
    )
    payload: JsonObject = {
        "type": GRADIENT_MOMENTUM_EVIDENCE_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "emaDecay": decay,
        "emaPreviousWeight": round_policy_number(decay),
        "emaCurrentWeight": round_policy_number(1.0 - decay),
        "smoothingFactor": round_policy_number(1.0 - decay),
        "previousGradientPresent": previous_gradient_present,
        "previousGradientUsed": previous_gradient_used,
        "momentumApplied": previous_gradient_used,
        "configuredPreviousGradientPresent": configured_previous_gradient_present,
        "gradientSchemeCompatible": gradient_scheme_compatible,
        "gradientSchemeComparisonStatus": scheme_status,
        "gradientSchemeKey": current_scheme_key,
        "gradientComparisonKey": current_comparison_key,
        "previousGradientSchemeKey": previous_scheme_key,
        "previousGradientComparisonKey": previous_comparison_key,
        "rawGradient": copy.deepcopy(raw_gradient),
        "emaGradient": ema_gradient,
        "rawEmaGradient": raw_ema_gradient,
        "momentumConsistent": not conflicting_parameters,
        "conflictingParameters": conflicting_parameters,
        "directionByParameter": direction_by_parameter,
        "rawVsMomentumAdjustedDirectionByParameter": raw_vs_momentum_direction_by_parameter,
        "updateGradientSource": "raw_ema_gradient",
        "trustGateEvidenceSource": "momentum_adjusted_gradient" if previous_gradient_used else "raw_gradient",
        "trustGateMomentumEvidenceUsed": previous_gradient_used,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }
    if current_scheme_identity is not None:
        payload["gradientSchemeIdentity"] = current_scheme_identity
    if isinstance(previous_scheme_identity, dict):
        payload["previousGradientSchemeIdentity"] = copy.deepcopy(previous_scheme_identity)
    state_artifact_path = text_or_none(config.get("stateArtifactPath"))
    state_key = text_or_none(config.get("stateKey"))
    state_identity = first_mapping(config, ("stateIdentity",))
    state_payload: JsonObject = {
        "type": GRADIENT_MOMENTUM_STATE_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "stateArtifactPath": state_artifact_path,
        "stateKey": state_key,
        "previousStateArtifactPresent": config.get("previousStateArtifactPresent") is True,
        "previousStateArtifactLoaded": config.get("previousStateArtifactLoaded") is True,
        "previousStateArtifactLoadError": text_or_none(config.get("previousStateArtifactLoadError")),
        "previousGradientSourcePath": text_or_none(config.get("previousGradientSourcePath")),
        "previousGradientSourceSha256": text_or_none(config.get("previousGradientSourceSha256")),
        "previousGradientSourceReportId": text_or_none(config.get("previousGradientSourceReportId")),
        "previousGradientSourceGeneratedAt": text_or_none(config.get("previousGradientSourceGeneratedAt")),
        "previousTrustedGradientUpdate": config.get("previousTrustedGradientUpdate"),
        "previousGradientTrustGateClassification": text_or_none(
            config.get("previousGradientTrustGateClassification")
        ),
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }
    if state_identity is not None:
        state_payload["stateIdentity"] = copy.deepcopy(state_identity)
    if state_artifact_path is not None:
        payload["stateArtifactPath"] = state_artifact_path
    if state_key is not None:
        payload["stateKey"] = state_key
    for key, value in state_payload.items():
        if key in {"type", "schemaVersion", "liveEffect", "officialMmoWrites", "officialMmoWritesAllowed", "safety"}:
            continue
        if value is not None:
            payload[key] = copy.deepcopy(value)
    payload["state"] = state_payload
    return payload


def policy_update_gradient_momentum_config(policy_gradient: JsonObject) -> JsonObject:
    configs = policy_update_gradient_state_config_candidates(policy_gradient)
    decay = DEFAULT_GRADIENT_EMA_DECAY
    previous_gradient: JsonObject = {}
    state_config: JsonObject = {}
    for raw in configs:
        raw_decay = first_present(
            raw,
            ("ema_decay", "emaDecay", "momentum", "momentumDecay", "gradient_ema_decay", "gradientEmaDecay"),
        )
        parsed_decay = number_or_none(raw_decay)
        if parsed_decay is not None and 0 <= float(parsed_decay) < 1:
            decay = float(parsed_decay)
        raw_previous = first_present(
            raw,
            (
                "previous_raw_ema_gradient",
                "previousRawEmaGradient",
                "previous_raw_gradient_ema",
                "previousRawGradientEma",
                "raw_ema_gradient",
                "rawEmaGradient",
                "previous_ema_gradient",
                "previousEmaGradient",
                "previous_gradient_ema",
                "previousGradientEma",
                "ema_gradient",
                "emaGradient",
            ),
        )
        if isinstance(raw_previous, dict):
            for name, value in raw_previous.items():
                parsed_value = number_or_none(value)
                if isinstance(name, str) and parsed_value is not None and math.isfinite(float(parsed_value)):
                    previous_gradient[name] = float(parsed_value)
        for key in (
            "stateArtifactPath",
            "stateKey",
            "stateIdentity",
            "previousStateArtifactPresent",
            "previousStateArtifactLoaded",
            "previousStateArtifactLoadError",
            "previousGradientSourcePath",
            "previousGradientSourceSha256",
            "previousGradientSourceReportId",
            "previousGradientSourceGeneratedAt",
            "previousTrustedGradientUpdate",
            "previousGradientTrustGateClassification",
        ):
            if key in raw:
                state_config[key] = copy.deepcopy(raw[key])

    previous_scheme = policy_update_previous_gradient_scheme_config(policy_gradient)
    return {
        "emaDecay": decay,
        "previousEmaGradient": previous_gradient,
        "previousGradientSchemeIdentity": previous_scheme["previousGradientSchemeIdentity"],
        "previousGradientSchemeKey": previous_scheme["previousGradientSchemeKey"],
        "previousGradientComparisonKey": previous_scheme["previousGradientComparisonKey"],
        **state_config,
    }


def policy_gradient_direction_sign(value: float | int) -> int:
    numeric = float(value)
    if abs(numeric) <= 1e-12:
        return 0
    return 1 if numeric > 0 else -1


def policy_update_gradient_stability_gate(
    *,
    policy_gradient: JsonObject,
    parameter_space: dict[str, JsonObject],
    candidates: Sequence[JsonObject],
    samples: Sequence[JsonObject],
    anchor_parameters: JsonObject,
    return_baseline: Sequence[float | int],
    gradient: JsonObject,
    selected_reward_tier_by_parameter: JsonObject,
    gradient_estimation: JsonObject | None = None,
    gradient_momentum: JsonObject | None = None,
) -> JsonObject:
    config = policy_update_gradient_stability_config(policy_gradient)
    min_samples_per_candidate = int(config["minimumSamplesPerCandidate"])
    consistency_threshold = float(config["directionConsistencyThreshold"])
    sample_count_by_candidate = {
        str(row.get("strategyVariantId") or row.get("candidatePolicyId") or "<unknown>"): int(
            row.get("returnSampleCount") if isinstance(row.get("returnSampleCount"), int) else 0
        )
        for row in candidates
    }
    insufficient_candidates = [
        {"strategyVariantId": variant_id, "returnSampleCount": sample_count}
        for variant_id, sample_count in sorted(sample_count_by_candidate.items())
        if sample_count < min_samples_per_candidate
    ]
    total_sample_count = len(samples)
    minimum_total_samples = max(min_samples_per_candidate * max(1, len(candidates)), min_samples_per_candidate)
    sample_size_sufficient = not insufficient_candidates and total_sample_count >= minimum_total_samples

    direction_by_parameter = policy_update_gradient_direction_evidence(
        parameter_space=parameter_space,
        samples=samples,
        anchor_parameters=anchor_parameters,
        return_baseline=return_baseline,
        gradient=gradient,
        selected_reward_tier_by_parameter=selected_reward_tier_by_parameter,
        gradient_estimation=gradient_estimation,
        consistency_threshold=consistency_threshold,
    )
    conflicting_parameters = [
        name
        for name, evidence in direction_by_parameter.items()
        if isinstance(evidence, dict) and evidence.get("directionStable") is False
    ]
    gradient_momentum = gradient_momentum if isinstance(gradient_momentum, dict) else None
    momentum_consistent = gradient_momentum is None or gradient_momentum.get("momentumConsistent") is not False
    gradient_scheme_comparable = (
        gradient_momentum is None or gradient_momentum.get("gradientSchemeCompatible") is not False
    )
    gradient_scheme_status = (
        text_or_none(gradient_momentum.get("gradientSchemeComparisonStatus"))
        if isinstance(gradient_momentum, dict)
        else None
    )
    conflicting_momentum_parameters = (
        list(gradient_momentum.get("conflictingParameters", []))
        if isinstance(gradient_momentum, dict) and isinstance(gradient_momentum.get("conflictingParameters"), list)
        else []
    )
    trust_gate_momentum_evidence_used = (
        gradient_momentum.get("trustGateMomentumEvidenceUsed") is True
        if isinstance(gradient_momentum, dict)
        else False
    )
    trust_gate_evidence_source = (
        text_or_none(gradient_momentum.get("trustGateEvidenceSource"))
        if isinstance(gradient_momentum, dict)
        else "raw_gradient"
    ) or "raw_gradient"

    direction_consistent = not conflicting_parameters
    gradient_stable = sample_size_sufficient and direction_consistent and momentum_consistent and gradient_scheme_comparable
    high_variance = not gradient_stable
    if not gradient_scheme_comparable:
        classification = "gradient_estimation_scheme_mismatch_non_comparable"
        convergence_label = "scheme_mismatch_not_comparable"
        reason = (
            "previous gradient evidence was recorded under a missing or different gradient-estimation "
            "scheme, so these samples are non-comparable and the trusted-gradient sample count must reset"
        )
    elif insufficient_candidates:
        classification = "insufficient_sample_high_variance"
        convergence_label = "sample_only_not_convergence"
        reason = (
            "true-gradient estimate has fewer Monte Carlo return samples per candidate than the "
            "configured trust threshold"
        )
    elif conflicting_parameters:
        classification = "conflicting_direction_high_variance"
        convergence_label = "high_variance_not_convergence"
        reason = (
            "true-gradient estimate has opposing per-sample update directions for selected lexicographic reward tiers"
        )
    elif conflicting_momentum_parameters:
        classification = "momentum_conflict_high_variance"
        convergence_label = "high_variance_not_convergence"
        reason = (
            "true-gradient estimate conflicts with the configured gradient EMA/momentum direction"
        )
    else:
        classification = "stable"
        convergence_label = "trusted_gradient_update"
        reason = "true-gradient estimate has sufficient samples and consistent per-sample update directions"

    payload: JsonObject = {
        "type": GRADIENT_STABILITY_GATE_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "status": "trusted" if gradient_stable else "untrusted",
        "classification": classification,
        "convergenceLabel": convergence_label,
        "convergenceStatus": "trusted" if gradient_stable else "not_converged_high_variance",
        "trueGradient": True,
        "gradientStable": gradient_stable,
        "trustedUpdate": gradient_stable,
        "trustedGradientUpdate": gradient_stable,
        "highVariance": high_variance,
        "sampleOnly": not sample_size_sufficient,
        "sampleSizeSufficient": sample_size_sufficient,
        "directionConsistent": direction_consistent,
        "momentumConsistent": momentum_consistent,
        "gradientSchemeComparable": gradient_scheme_comparable,
        "gradientSchemeComparisonStatus": gradient_scheme_status,
        "trustGateEvidenceSource": trust_gate_evidence_source,
        "trustGateMomentumEvidenceUsed": trust_gate_momentum_evidence_used,
        "trustGateEvidence": {
            "directionConsistencySource": "raw_gradient_estimation_contribution_directions",
            "momentumEvidenceSource": trust_gate_evidence_source,
            "momentumEvidenceUsed": trust_gate_momentum_evidence_used,
        },
        "minimumSamplesPerCandidate": min_samples_per_candidate,
        "minimumTotalSamples": minimum_total_samples,
        "totalReturnSampleCount": total_sample_count,
        "sampleCountByCandidate": sample_count_by_candidate,
        "insufficientCandidates": insufficient_candidates,
        "conflictingParameters": conflicting_parameters,
        "conflictingMomentumParameters": conflicting_momentum_parameters,
        "directionConsistencyThreshold": consistency_threshold,
        "directionByParameter": direction_by_parameter,
        "reason": reason,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }
    if isinstance(gradient_estimation, dict):
        payload["gradientEstimation"] = copy.deepcopy(gradient_estimation)
        payload["gradientSchemeKey"] = text_or_none(gradient_estimation.get("schemeKey"))
        payload["gradientComparisonKey"] = text_or_none(gradient_estimation.get("comparisonKey"))
        scheme_identity = first_mapping(gradient_estimation, ("schemeIdentity",))
        if scheme_identity is not None:
            payload["gradientSchemeIdentity"] = copy.deepcopy(scheme_identity)
    if isinstance(gradient_momentum, dict):
        payload["gradientMomentum"] = copy.deepcopy(gradient_momentum)
    return payload


def policy_update_gradient_stability_with_parameter_evidence(
    gradient_stability: JsonObject,
    parameter_evidence: JsonObject,
) -> JsonObject:
    if (
        gradient_stability.get("trustedUpdate") is not True
        or parameter_evidence.get("eligibilityMode") != "runtime_injected_metadata_scorecard_ranking"
        or parameter_evidence.get("runtimeParameterConsumption") is True
    ):
        return gradient_stability

    payload = copy.deepcopy(gradient_stability)
    reason = (
        "runtime-injected candidate metadata produced an offline scorecard ranking, but the private simulator "
        "did not expose runtime parameter consumption evidence, so the gradient remains offline/shadow-only "
        "and untrusted"
    )
    payload.update(
        {
            "status": "untrusted",
            "classification": "runtime_parameter_consumption_missing",
            "convergenceLabel": "runtime_parameter_consumption_missing",
            "convergenceStatus": "not_converged_high_variance",
            "gradientStable": False,
            "trustedUpdate": False,
            "trustedGradientUpdate": False,
            "highVariance": True,
            "reason": reason,
        }
    )
    return payload


def policy_update_gradient_direction_evidence(
    *,
    parameter_space: dict[str, JsonObject],
    samples: Sequence[JsonObject],
    anchor_parameters: JsonObject,
    return_baseline: Sequence[float | int],
    gradient: JsonObject,
    selected_reward_tier_by_parameter: JsonObject,
    gradient_estimation: JsonObject | None,
    consistency_threshold: float,
) -> JsonObject:
    if isinstance(gradient_estimation, dict) and isinstance(gradient_estimation.get("directionByParameter"), dict):
        direction_by_parameter = copy.deepcopy(gradient_estimation["directionByParameter"])
        for evidence in direction_by_parameter.values():
            if not isinstance(evidence, dict):
                continue
            nonzero_count = int(evidence.get("nonZeroContributionCount", 0))
            positive_count = int(evidence.get("positiveContributionCount", 0))
            negative_count = int(evidence.get("negativeContributionCount", 0))
            dominant_ratio = float(evidence.get("dominantDirectionRatio", 1.0))
            evidence["directionConsistencyThreshold"] = consistency_threshold
            evidence["directionStable"] = (
                nonzero_count == 0
                or positive_count == 0
                or negative_count == 0
                or dominant_ratio >= consistency_threshold
            )
        return direction_by_parameter

    direction_by_parameter: JsonObject = {}
    for name, selected_gradient in gradient.items():
        selected_tier = text_or_none(selected_reward_tier_by_parameter.get(name))
        if selected_tier not in REWARD_TIERS:
            direction_by_parameter[name] = {
                "selectedRewardTier": selected_tier,
                "gradient": selected_gradient,
                "directionStable": True,
                "reason": "zero_selected_gradient",
            }
            continue
        tier_index = REWARD_TIERS.index(selected_tier)
        spec = parameter_space.get(name)
        if spec is None:
            continue
        span = max(float(spec["max"]) - float(spec["min"]), 1.0)
        anchor_value = float(anchor_parameters[name])
        positive_count = 0
        negative_count = 0
        zero_count = 0
        contribution_sum = 0.0
        for sample in samples:
            row = sample["candidate"]
            normalized_delta = (float(row["parameters"][name]) - anchor_value) / span
            advantage = float(sample["returnTuple"][tier_index]) - float(return_baseline[tier_index])
            contribution = advantage * normalized_delta
            contribution_sum += contribution
            if contribution > 1e-12:
                positive_count += 1
            elif contribution < -1e-12:
                negative_count += 1
            else:
                zero_count += 1
        nonzero_count = positive_count + negative_count
        dominant_count = max(positive_count, negative_count)
        dominant_ratio = 1.0 if nonzero_count == 0 else dominant_count / nonzero_count
        direction_stable = nonzero_count == 0 or positive_count == 0 or negative_count == 0 or dominant_ratio >= consistency_threshold
        direction_by_parameter[name] = {
            "selectedRewardTier": selected_tier,
            "gradient": selected_gradient,
            "contributionSum": round_policy_number(contribution_sum),
            "positiveContributionCount": positive_count,
            "negativeContributionCount": negative_count,
            "zeroContributionCount": zero_count,
            "nonZeroContributionCount": nonzero_count,
            "dominantDirectionRatio": round_policy_number(dominant_ratio),
            "directionConsistencyThreshold": consistency_threshold,
            "directionStable": direction_stable,
        }
    return direction_by_parameter


def policy_update_gradient_stability_config(policy_gradient: JsonObject) -> JsonObject:
    configs: list[JsonObject] = []
    for raw in policy_update_config_candidates(policy_gradient):
        configs.append(raw)
        for key in ("gradient_stability_gate", "gradientStabilityGate", "gradient_trust_gate", "gradientTrustGate"):
            nested = raw.get(key)
            if isinstance(nested, dict):
                configs.append(nested)

    min_samples = DEFAULT_GRADIENT_TRUST_MIN_SAMPLES_PER_CANDIDATE
    consistency_threshold = DEFAULT_GRADIENT_DIRECTION_CONSISTENCY_THRESHOLD
    for raw in configs:
        raw_min_samples = first_present(
            raw,
            (
                "minimum_samples_per_candidate",
                "minimumSamplesPerCandidate",
                "min_samples_per_candidate",
                "minSamplesPerCandidate",
            ),
        )
        parsed_min_samples = int_or_none(raw_min_samples)
        if parsed_min_samples is not None and parsed_min_samples > 0:
            min_samples = parsed_min_samples
        raw_threshold = first_present(
            raw,
            (
                "direction_consistency_threshold",
                "directionConsistencyThreshold",
                "consistency_threshold",
                "consistencyThreshold",
            ),
        )
        parsed_threshold = number_or_none(raw_threshold)
        if parsed_threshold is not None and 0.5 <= float(parsed_threshold) <= 1:
            consistency_threshold = float(parsed_threshold)

    return {
        "minimumSamplesPerCandidate": min_samples,
        "directionConsistencyThreshold": consistency_threshold,
    }


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
    if policy_gradient_candidate_parameters_metadata_only(policy_gradient):
        return []
    require_evaluated_parameters = policy_gradient_requires_runtime_parameter_evidence(policy_gradient)
    allow_runtime_metadata_fallback = policy_gradient_allows_runtime_metadata_policy_update(policy_gradient)
    raw_candidates = first_present(policy_gradient, ("candidate_parameter_vectors", "candidateParameterVectors"))
    if not isinstance(raw_candidates, list):
        return []
    result_groups: dict[str, list[JsonObject]] = {}
    for result in results:
        variant_id = text_or_none(result.get("variantId"))
        if variant_id is None:
            continue
        base_id = simulator_harness.scale_environment_base_variant_id(variant_id)
        result_keys = {base_id}
        candidate_policy_id = text_or_none(result.get("candidatePolicyId"))
        runtime_injection = result.get("runtimeParameterInjection")
        if candidate_policy_id is None and isinstance(runtime_injection, dict):
            candidate_policy_id = text_or_none(runtime_injection.get("candidatePolicyId"))
        if candidate_policy_id is not None:
            result_keys.add(candidate_policy_id)
        for result_key in result_keys:
            result_groups.setdefault(result_key, []).append(result)

    rows: list[JsonObject] = []
    for candidate in raw_candidates:
        if not isinstance(candidate, dict):
            continue
        strategy_variant_id = text_or_none(candidate.get("strategyVariantId"))
        candidate_policy_id = text_or_none(candidate.get("candidatePolicyId"))
        candidate_match_id = strategy_variant_id or candidate_policy_id
        if candidate_match_id is None:
            continue
        summaries = result_groups.get(strategy_variant_id or "") or result_groups.get(candidate_policy_id or "") or []
        scored_summaries = [summary for summary in summaries if policy_reward_tuple_values(summary) is not None]
        if not scored_summaries:
            continue
        card_parameters = bounded_policy_parameters(candidate.get("parameters"), parameter_space)
        parameters = policy_update_evaluated_parameters(
            candidate=candidate,
            scored_summaries=scored_summaries,
            card_parameters=card_parameters,
            parameter_space=parameter_space,
            require_evaluated_parameters=require_evaluated_parameters,
            allow_runtime_metadata_fallback=allow_runtime_metadata_fallback,
        )
        if parameters is None:
            continue
        return_samples = policy_update_return_samples(scored_summaries)
        row = {
            "candidatePolicyId": candidate_policy_id,
            "strategyVariantId": candidate_match_id,
            "sourceStrategyId": text_or_none(candidate.get("sourceStrategyId")),
            "rolloutStatus": text_or_none(candidate.get("rolloutStatus")),
            "parameters": parameters,
            "rewardTuple": aggregate_policy_reward_tuple(scored_summaries),
            "sampleCount": sum(policy_reward_tuple_sample_weight(summary) for summary in scored_summaries),
            "returnSamples": return_samples,
            "returnSampleCount": len(return_samples),
            "meanReturn": mean_policy_return_tuple(return_samples),
            "resultVariantIds": [
                summary["variantId"] for summary in scored_summaries if isinstance(summary.get("variantId"), str)
            ],
        }
        scalar_return_samples = policy_update_scalar_return_samples(scored_summaries)
        if scalar_return_samples:
            row["scalarReturnSamples"] = scalar_return_samples
            row["scalarReward"] = round_policy_number(
                statistics.fmean(float(value) for value in scalar_return_samples)
            )
        rows.append(row)
    return rows


def policy_update_evaluated_parameters(
    *,
    candidate: JsonObject,
    scored_summaries: Sequence[JsonObject],
    card_parameters: JsonObject | None,
    parameter_space: dict[str, JsonObject],
    require_evaluated_parameters: bool = False,
    allow_runtime_metadata_fallback: bool = False,
) -> JsonObject | None:
    evaluated: list[JsonObject] = []
    missing_evaluated: list[str] = []
    for summary in scored_summaries:
        source = policy_update_summary_parameter_source(summary, runtime_required=require_evaluated_parameters)
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

    if require_evaluated_parameters and not allow_runtime_metadata_fallback:
        return None
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


def policy_update_scalar_return_samples(summaries: Sequence[JsonObject]) -> list[float | int]:
    samples: list[float | int] = []
    for summary in summaries:
        reward = summary.get("reward") if isinstance(summary.get("reward"), dict) else {}
        scalar_reward = reward.get("scalarWeightedSum") if isinstance(reward, dict) else None
        if not isinstance(scalar_reward, dict):
            continue
        raw_samples = scalar_reward.get("scalarReturnSamples")
        added_samples = False
        if isinstance(raw_samples, list):
            for raw_sample in raw_samples:
                value = number_or_none(raw_sample)
                if value is not None:
                    samples.append(round_policy_number(float(value)))
                    added_samples = True
        if added_samples:
            continue
        value = number_or_none(scalar_reward.get("scalarReward"))
        if value is None:
            continue
        weight = policy_reward_tuple_sample_weight(summary)
        for _index in range(max(0, weight)):
            samples.append(round_policy_number(float(value)))
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


def policy_update_summary_parameter_source(
    summary: JsonObject,
    *,
    runtime_required: bool = False,
) -> tuple[str, Any] | None:
    fields = ("evaluatedParameters", "evaluated_parameters") if runtime_required else (
        "evaluatedParameters",
        "evaluated_parameters",
        "parameters",
    )
    for field in fields:
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


def policy_update_uses_bounded_integer_step(policy_gradient: JsonObject) -> bool:
    for raw in policy_update_config_candidates(policy_gradient):
        value = first_present(raw, ("bounded_integer_step", "boundedIntegerStep"))
        if isinstance(value, bool):
            return value
    return False


def bounded_policy_parameter_value(value: float, spec: JsonObject) -> float | int:
    minimum = float(spec["min"])
    maximum = float(spec["max"])
    bounded = max(minimum, min(maximum, value))
    return round_policy_number(bounded)


def bounded_policy_parameter_step_value(value: float, spec: JsonObject) -> float | int:
    minimum = float(spec["min"])
    maximum = float(spec["max"])
    bounded = max(minimum, min(maximum, value))
    step = number_or_none(spec.get("step"))
    if step is None or float(step) <= 0:
        return round_policy_number(bounded)
    step_float = float(step)
    quantized_steps = round((bounded - minimum) / step_float)
    quantized = minimum + (quantized_steps * step_float)
    return round_policy_number(max(minimum, min(maximum, quantized)))


def bounded_policy_parameter_integer_step_update(
    *,
    anchor_value: float,
    gradient_value: float,
    learning_rate: float,
    spec: JsonObject,
) -> float | int:
    minimum = float(spec["min"])
    maximum = float(spec["max"])
    span = max(maximum - minimum, 1.0)
    effective_delta = float(learning_rate) * float(gradient_value) * span
    if abs(effective_delta) <= 1e-12:
        return bounded_policy_parameter_value(anchor_value, spec)
    step = number_or_none(spec.get("step"))
    step_float = float(step) if step is not None and float(step) > 0 else 1.0
    step_units = abs(effective_delta) / step_float
    step_count = max(1, int(math.floor(step_units + 0.5 + 1e-12)))
    direction = 1.0 if effective_delta > 0 else -1.0
    return bounded_policy_parameter_step_value(
        anchor_value + (direction * step_float * step_count),
        spec,
    )


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
        "scalarReward": row.get("scalarReward"),
        "scalarReturnSamples": copy.deepcopy(row.get("scalarReturnSamples")),
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


def materialize_policy_gradient_momentum_state(
    report: JsonObject,
    out_dir: Path,
    report_path: Path,
    secret_values: Sequence[str] = (),
) -> Path | None:
    if report.get("trueGradient") is not True:
        return None
    update = report.get("policyUpdate")
    policy_gradient = report.get("policyGradient")
    if not isinstance(update, dict) or not isinstance(policy_gradient, dict):
        return None
    momentum = update.get("gradientMomentum")
    if not isinstance(momentum, dict):
        return None
    state_identity = policy_update_gradient_momentum_state_identity(policy_gradient)
    state_path = policy_update_gradient_momentum_state_path(policy_gradient, out_dir)
    if state_identity is None or state_path is None:
        return None

    state_key = policy_update_gradient_momentum_state_key(state_identity)
    state_artifact_path = dataset_export.display_path(state_path)
    state_metadata: JsonObject = {
        "stateArtifactPath": state_artifact_path,
        "stateKey": state_key,
        "stateIdentity": copy.deepcopy(state_identity),
        "stateMaterialized": True,
    }
    update_gradient_momentum_report_metadata(report, state_metadata)
    momentum = update["gradientMomentum"]

    state_payload = copy.deepcopy(momentum)
    state_payload.update(
        {
            "stateArtifactType": GRADIENT_MOMENTUM_STATE_TYPE,
            "stateArtifactPath": state_artifact_path,
            "stateKey": state_key,
            "stateIdentity": copy.deepcopy(state_identity),
            "sourceReportId": report.get("reportId"),
            "sourceReportGeneratedAt": report.get("generatedAt"),
            "sourceReportPath": dataset_export.display_path(report_path),
            "sourcePolicyUpdateAlgorithm": report.get("policyUpdateAlgorithm"),
            "sourceTrustedGradientUpdate": report.get("trustedGradientUpdate"),
            "sourceGradientStable": report.get("gradientStable"),
            "sourceHighVariance": report.get("highVariance"),
            "sourceGradientTrustGateClassification": report.get("gradientTrustGateClassification"),
            "sourceGradientTrustGateReason": report.get("gradientTrustGateReason"),
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
            "safety": safety_metadata(),
        }
    )
    state_payload["statePayloadHash"] = policy_update_gradient_momentum_state_payload_hash(state_payload)
    assert_no_secret_leak(state_payload, secret_values)
    write_json_atomic(state_path, state_payload)

    state_summary = {
        "type": GRADIENT_MOMENTUM_STATE_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "stateArtifactPath": state_artifact_path,
        "stateKey": state_key,
        "stateIdentity": copy.deepcopy(state_identity),
        "statePayloadHash": state_payload["statePayloadHash"],
        "stateMaterialized": True,
        "sourceReportId": report.get("reportId"),
        "sourceReportGeneratedAt": report.get("generatedAt"),
        "previousGradientPresent": momentum.get("previousGradientPresent") is True,
        "previousGradientUsed": momentum.get("previousGradientUsed") is True,
        "previousGradientSourcePath": momentum.get("previousGradientSourcePath"),
        "previousGradientSourceSha256": momentum.get("previousGradientSourceSha256"),
        "previousGradientSourceReportId": momentum.get("previousGradientSourceReportId"),
        "previousStateArtifactLoadError": momentum.get("previousStateArtifactLoadError"),
        "emaDecay": momentum.get("emaDecay"),
        "smoothingFactor": momentum.get("smoothingFactor"),
        "trustGateEvidenceSource": momentum.get("trustGateEvidenceSource"),
        "trustedGradientUpdate": report.get("trustedGradientUpdate"),
        "gradientStable": report.get("gradientStable"),
        "highVariance": report.get("highVariance"),
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }
    report["gradientMomentumState"] = state_summary
    update_gradient_momentum_report_metadata(
        report,
        {
            "statePayloadHash": state_payload["statePayloadHash"],
            "stateMaterialized": True,
        },
    )
    return state_path


def update_gradient_momentum_report_metadata(report: JsonObject, metadata: JsonObject) -> None:
    update = report.get("policyUpdate")
    if not isinstance(update, dict) or not isinstance(update.get("gradientMomentum"), dict):
        return
    update["gradientMomentum"].update(copy.deepcopy(metadata))
    report["gradientMomentum"] = copy.deepcopy(update["gradientMomentum"])
    next_candidate_policy = update.get("nextCandidatePolicy")
    if isinstance(next_candidate_policy, dict):
        next_candidate_policy["gradientMomentum"] = copy.deepcopy(update["gradientMomentum"])
        parameter_evidence = next_candidate_policy.get("parameterEvidence")
        if isinstance(parameter_evidence, dict):
            parameter_evidence["gradientMomentum"] = copy.deepcopy(update["gradientMomentum"])


def policy_gradient_momentum_state_artifact_path_for_report(report: JsonObject, out_dir: Path) -> Path | None:
    if report.get("trueGradient") is not True:
        return None
    update = report.get("policyUpdate")
    policy_gradient = report.get("policyGradient")
    if not isinstance(update, dict) or not isinstance(policy_gradient, dict):
        return None
    if not isinstance(update.get("gradientMomentum"), dict):
        return None
    return policy_update_gradient_momentum_state_path(policy_gradient, out_dir)


def materialize_candidate_scorecard_artifact(
    report: JsonObject,
    out_dir: Path,
    secret_values: Sequence[str],
) -> None:
    """Persist #924 scorecards for every completed policy-gradient candidate/baseline pair."""
    if not isinstance(report.get("policyGradient"), dict):
        return

    comparisons = build_candidate_scorecard_readiness_rows(report)
    scorecard_set = build_candidate_scorecard_set_payload(report, comparisons)
    report["candidateScorecards"] = scorecard_set
    if not comparisons:
        readiness = build_candidate_scorecard_readiness(report)
        report["candidateScorecard"] = readiness
        report["scorecardId"] = None
        report["scorecardArtifactPath"] = None
        return

    selected = comparisons[0]
    report["candidateScorecard"] = selected
    report["scorecardId"] = selected.get("scorecardId")
    report["scorecardArtifactPath"] = selected.get("scorecardArtifactPath")

    for readiness in comparisons:
        if readiness.get("status") not in {"ready", "materialized"}:
            continue
        materialize_candidate_scorecard_comparison(report, out_dir, secret_values, readiness)

    finalize_candidate_scorecard_set_payload(scorecard_set)
    report["scorecardId"] = selected.get("scorecardId")
    report["scorecardArtifactPath"] = selected.get("scorecardArtifactPath")


def materialize_candidate_scorecard_comparison(
    report: JsonObject,
    out_dir: Path,
    secret_values: Sequence[str],
    readiness: JsonObject,
) -> None:
    candidate_id = text_or_none(readiness.get("candidateStrategyId"))
    baseline_id = text_or_none(readiness.get("baselineStrategyId"))
    scorecard_id = text_or_none(readiness.get("scorecardId"))
    if candidate_id is None or baseline_id is None or scorecard_id is None:
        readiness.update(
            candidate_scorecard_blocked_payload(
                report,
                classification="scorecard_pair_incomplete",
                reason="candidate-vs-baseline scorecard pair was incomplete after readiness planning",
                missing_prerequisite="candidate_baseline_pair",
            )
        )
        return

    candidate_result = variant_result_by_id(report, candidate_id)
    baseline_result = variant_result_by_id(report, baseline_id)
    if candidate_result is None or baseline_result is None:
        readiness.update(
            candidate_scorecard_blocked_payload(
                report,
                classification="scorecard_variant_result_missing",
                reason="candidate-vs-baseline scorecard source variant result was missing",
                missing_prerequisite="candidate_baseline_variant_results",
            )
        )
        return

    safe_report_id = safe_artifact_stem(text_or_none(report.get("reportId")) or "rl-training")
    pair_stem = safe_scorecard_pair_stem(candidate_id, baseline_id)
    scorecard_root = out_dir / CANDIDATE_SCORECARD_ARTIFACT_DIR / safe_report_id / pair_stem
    candidate_dir = scorecard_root / "candidate"
    baseline_dir = scorecard_root / "baseline"
    candidate_projection = scorecard_projection_payload(
        report,
        result=candidate_result,
        role="candidate",
        peer_variant_id=baseline_id,
        runtime_parameter_injection=candidate_scorecard_runtime_parameter_injection(report, candidate_id),
    )
    baseline_projection = scorecard_projection_payload(
        report,
        result=baseline_result,
        role="baseline",
        peer_variant_id=candidate_id,
        runtime_parameter_injection=None,
    )
    for payload in (candidate_projection, baseline_projection):
        assert_no_secret_leak(payload, secret_values)

    candidate_input = candidate_dir / "training-ledger.json"
    baseline_input = baseline_dir / "training-ledger.json"
    write_json_atomic(candidate_input, candidate_projection)
    write_json_atomic(baseline_input, baseline_projection)

    scorecard = scorecard_helper.build_scorecard(
        candidate_path=candidate_dir,
        baseline_path=baseline_dir,
        repo_root=REPO_ROOT,
        run_id=scorecard_id,
        timestamp=text_or_none(report.get("generatedAt")),
        candidate_id=candidate_id,
        baseline_id=baseline_id,
    )
    assert_no_secret_leak(scorecard, secret_values)
    scorecard_path = scorecard_root / f"{safe_artifact_stem(scorecard_id)}.json"
    write_json_atomic(scorecard_path, scorecard)

    display = dataset_export.display_path(scorecard_path)
    readiness["scorecardArtifactPath"] = display
    readiness["overallGate"] = {
        "status": scorecard.get("overallGate", {}).get("status") if isinstance(scorecard.get("overallGate"), dict) else None,
        "rationale": scorecard.get("overallGate", {}).get("rationale")
        if isinstance(scorecard.get("overallGate"), dict)
        else None,
        "runtimeParameterInjectionProven": scorecard.get("overallGate", {})
        .get("monotonic", {})
        .get("runtimeParameterInjectionProven")
        if isinstance(scorecard.get("overallGate"), dict)
        and isinstance(scorecard.get("overallGate", {}).get("monotonic"), dict)
        else None,
    }


def mark_candidate_scorecard_materialization_failed(report: JsonObject, error: Exception) -> None:
    reason = f"candidate scorecard artifact generation failed: {error}"
    warning = f"candidate scorecard artifact generation skipped: {error}"
    warnings = report.get("warnings")
    if isinstance(warnings, list):
        warnings.append(warning)
    else:
        report["warnings"] = [warning]
    previous_readiness = report.get("candidateScorecard")
    runtime_parameter_injection = report.get("runtimeParameterInjection")
    payload = candidate_scorecard_blocked_payload(
        report,
        classification="candidate_scorecard_materialization_failed",
        reason=reason,
        missing_prerequisite="candidate_scorecard_artifact",
    )
    payload["nextAction"] = "inspect and repair candidate scorecard materialization before validation-scale compute"
    payload["runtimeParameterInjection"] = scorecard_runtime_injection_ready(runtime_parameter_injection)
    payload["runtimeParameterConsumption"] = scorecard_runtime_consumption_ready(runtime_parameter_injection)
    payload["injectedVariantCount"] = runtime_injected_variant_count(runtime_parameter_injection)
    payload["consumedVariantCount"] = runtime_consumed_variant_count(runtime_parameter_injection)
    payload["candidateParameterScope"] = runtime_parameter_scope(runtime_parameter_injection)
    if isinstance(previous_readiness, dict):
        for field in ("candidateStrategyId", "baselineStrategyId", "candidateRank", "baselineRank"):
            if field in previous_readiness:
                payload[field] = copy.deepcopy(previous_readiness[field])
    else:
        pair = candidate_scorecard_pair(report)
        if pair is not None:
            candidate_id, baseline_id, candidate_rank, baseline_rank = pair
            payload["candidateStrategyId"] = candidate_id
            payload["baselineStrategyId"] = baseline_id
            payload["candidateRank"] = candidate_rank
            payload["baselineRank"] = baseline_rank
    report["candidateScorecard"] = payload
    scorecard_set = report.get("candidateScorecards")
    if isinstance(scorecard_set, dict):
        comparison_count = 0
        comparisons = scorecard_set.get("comparisons")
        if isinstance(comparisons, list):
            for comparison in comparisons:
                if not isinstance(comparison, dict):
                    continue
                comparison_count += 1
                preserved = {
                    field: copy.deepcopy(comparison[field])
                    for field in (
                        "candidateStrategyId",
                        "baselineStrategyId",
                        "candidateRank",
                        "baselineRank",
                        "comparisonKey",
                    )
                    if field in comparison
                }
                comparison.clear()
                comparison.update(copy.deepcopy(payload))
                comparison.update(preserved)
        scorecard_set["status"] = "blocked"
        scorecard_set["classification"] = "candidate_scorecard_materialization_failed"
        scorecard_set["scorecardUsable"] = False
        scorecard_set["validationScaleComputeBlocked"] = True
        scorecard_set["missingPrerequisite"] = "candidate_scorecard_artifact"
        scorecard_set["missingPrerequisites"] = ["candidate_scorecard_artifact"]
        scorecard_set["reason"] = reason
        scorecard_set["reasonCodes"] = ["candidate_scorecard_materialization_failed"]
        scorecard_set["selectedScorecardId"] = None
        scorecard_set["materializedScorecardCount"] = 0
        scorecard_set["blockedComparisonCount"] = comparison_count
        scorecard_set["readyComparisonCount"] = 0
    report["scorecardId"] = None
    report["scorecardArtifactPath"] = None


def build_candidate_scorecard_readiness(report: JsonObject) -> JsonObject:
    pair = candidate_scorecard_pair(report)
    if pair is None:
        return candidate_scorecard_blocked_payload(
            report,
            classification="candidate_baseline_pair_missing",
            reason="ranking did not contain both a candidate and an incumbent baseline variant",
            missing_prerequisite="candidate_baseline_ranking",
        )
    candidate_id, baseline_id, candidate_rank, baseline_rank = pair
    return build_candidate_scorecard_readiness_for_pair(
        report,
        candidate_id=candidate_id,
        baseline_id=baseline_id,
        candidate_rank=candidate_rank,
        baseline_rank=baseline_rank,
    )


def build_candidate_scorecard_readiness_rows(report: JsonObject) -> list[JsonObject]:
    return [
        build_candidate_scorecard_readiness_for_pair(
            report,
            candidate_id=candidate_id,
            baseline_id=baseline_id,
            candidate_rank=candidate_rank,
            baseline_rank=baseline_rank,
        )
        for candidate_id, baseline_id, candidate_rank, baseline_rank in candidate_scorecard_pairs(report)
    ]


def build_candidate_scorecard_readiness_for_pair(
    report: JsonObject,
    *,
    candidate_id: str,
    baseline_id: str,
    candidate_rank: int | None,
    baseline_rank: int | None,
) -> JsonObject:
    report_runtime_parameter_injection = report.get("runtimeParameterInjection")
    candidate_metadata = role_policy_metadata_for_variant(report, candidate_id)
    baseline_metadata = role_policy_metadata_for_variant(report, baseline_id)
    scorecard_id = candidate_scorecard_id(report, candidate_id, baseline_id)
    runtime_parameter_injection = candidate_scorecard_runtime_parameter_injection(report, candidate_id)
    runtime_ready = scorecard_runtime_injection_ready(runtime_parameter_injection)
    runtime_consumed = scorecard_runtime_consumption_ready(runtime_parameter_injection)
    runtime_gate_ready = runtime_ready and runtime_consumed
    gradient_stability = report.get("gradientStability")
    gradient_gate_present = isinstance(gradient_stability, dict)
    trusted_gradient_update = report.get("trustedGradientUpdate") is True if gradient_gate_present else True
    injected_count = runtime_injected_variant_count(runtime_parameter_injection)
    report_injected_count = runtime_injected_variant_count(report_runtime_parameter_injection)
    consumed_count = runtime_consumed_variant_count(runtime_parameter_injection)
    report_consumed_count = runtime_consumed_variant_count(report_runtime_parameter_injection)
    if runtime_gate_ready and trusted_gradient_update:
        status = "ready"
        classification = "runtime_injected_candidate_scorecard_ready"
        reason = None
        next_action = None
        missing_prerequisite = None
    elif runtime_gate_ready:
        status = "materialized"
        classification = "gradient_stability_untrusted_scorecard_materialized"
        missing_prerequisite = "gradient_stability"
        reason = (
            "true-gradient update is marked high-variance or otherwise untrusted; "
            "candidate-vs-baseline scorecard will be materialized from completed offline ranking/KPI "
            "evidence but cannot pass the gradient stability gate"
        )
        next_action = "collect sufficient consistent policy-gradient samples before promotion"
    else:
        status = "materialized"
        classification = candidate_scorecard_materialized_classification(runtime_parameter_injection)
        missing_prerequisite = candidate_scorecard_runtime_missing_prerequisite(runtime_parameter_injection)
        reason = (
            f"{candidate_scorecard_runtime_blocker_reason(runtime_parameter_injection)}; "
            "candidate-vs-baseline scorecard will be materialized from completed offline ranking/KPI "
            "evidence but cannot pass the runtime candidate gate"
        )
        next_action = (
            f"{candidate_scorecard_runtime_next_action(runtime_parameter_injection)}; "
            "retain this scorecard as offline/private evidence"
        )
    payload: JsonObject = {
        "type": "screeps-rl-candidate-vs-baseline-scorecard-readiness",
        "schemaVersion": SCHEMA_VERSION,
        "status": status,
        "classification": classification,
        "scorecardId": scorecard_id,
        "scorecardArtifactPath": None,
        "candidateStrategyId": candidate_id,
        "baselineStrategyId": baseline_id,
        "candidateRank": candidate_rank,
        "baselineRank": baseline_rank,
        "comparisonKey": f"{candidate_id}::vs::{baseline_id}",
        "policyFamily": candidate_metadata.get("policyFamily"),
        "rolePolicy": candidate_metadata.get("rolePolicy"),
        "trainingRole": candidate_metadata.get("trainingRole"),
        "candidatePolicyMetadata": candidate_metadata,
        "baselinePolicyMetadata": baseline_metadata,
        "runtimeParameterInjection": runtime_ready,
        "runtimeParameterConsumption": runtime_consumed,
        "injectedVariantCount": injected_count,
        "consumedVariantCount": consumed_count,
        "candidateParameterScope": runtime_parameter_scope(runtime_parameter_injection),
        "reportRuntimeParameterInjection": scorecard_runtime_injection_ready(report_runtime_parameter_injection),
        "reportRuntimeParameterConsumption": scorecard_runtime_consumption_ready(report_runtime_parameter_injection),
        "reportInjectedVariantCount": report_injected_count,
        "reportConsumedVariantCount": report_consumed_count,
        "scorecardUsable": True,
        "validationScaleComputeBlocked": not (runtime_gate_ready and trusted_gradient_update),
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }
    if gradient_gate_present:
        payload["gradientStable"] = report.get("gradientStable")
        payload["trustedGradientUpdate"] = report.get("trustedGradientUpdate")
        payload["highVariance"] = report.get("highVariance")
    if reason is not None:
        payload["missingPrerequisite"] = missing_prerequisite
        payload["reason"] = reason
    if next_action is not None:
        payload["nextAction"] = next_action
    return payload


def build_candidate_scorecard_set_payload(report: JsonObject, comparisons: Sequence[JsonObject]) -> JsonObject:
    if not comparisons:
        return {
            "type": MULTI_CANDIDATE_SCORECARD_SET_TYPE,
            "schemaVersion": SCHEMA_VERSION,
            "status": "blocked",
            "classification": "candidate_baseline_pair_missing",
            "reportId": report.get("reportId"),
            "comparisonCount": 0,
            "candidateCount": 0,
            "baselineCount": 0,
            "materializedScorecardCount": 0,
            "scorecardUsable": False,
            "validationScaleComputeBlocked": True,
            "missingPrerequisite": "candidate_baseline_ranking",
            "reason": "ranking did not contain both a candidate and an incumbent baseline variant",
            "comparisons": [],
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
            "safety": safety_metadata(),
        }
    candidate_ids = sorted(
        {item["candidateStrategyId"] for item in comparisons if isinstance(item.get("candidateStrategyId"), str)}
    )
    baseline_ids = sorted(
        {item["baselineStrategyId"] for item in comparisons if isinstance(item.get("baselineStrategyId"), str)}
    )
    payload: JsonObject = {
        "type": MULTI_CANDIDATE_SCORECARD_SET_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "status": "planned",
        "classification": "multi_candidate_scorecards_planned",
        "reportId": report.get("reportId"),
        "comparisonCount": len(comparisons),
        "candidateCount": len(candidate_ids),
        "baselineCount": len(baseline_ids),
        "candidateStrategyIds": candidate_ids,
        "baselineStrategyIds": baseline_ids,
        "selectedScorecardId": comparisons[0].get("scorecardId"),
        "comparisons": list(comparisons),
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }
    finalize_candidate_scorecard_set_payload(payload)
    return payload


def finalize_candidate_scorecard_set_payload(payload: JsonObject) -> None:
    comparisons = [item for item in payload.get("comparisons", []) if isinstance(item, dict)]
    materialized_count = sum(1 for item in comparisons if text_or_none(item.get("scorecardArtifactPath")) is not None)
    blocked_count = sum(1 for item in comparisons if item.get("status") == "blocked")
    ready_count = sum(1 for item in comparisons if item.get("status") == "ready")
    validation_blocked = any(item.get("validationScaleComputeBlocked") is True for item in comparisons)
    usable = bool(comparisons) and all(item.get("scorecardUsable") is True for item in comparisons)
    missing_prerequisites = sorted(
        {
            str(item["missingPrerequisite"])
            for item in comparisons
            if isinstance(item.get("missingPrerequisite"), str)
        }
    )
    reason_codes = sorted(
        {
            str(item.get("classification"))
            for item in comparisons
            if isinstance(item.get("classification"), str)
        }
    )
    payload["materializedScorecardCount"] = materialized_count
    payload["blockedComparisonCount"] = blocked_count
    payload["readyComparisonCount"] = ready_count
    payload["validationScaleComputeBlocked"] = validation_blocked
    payload["scorecardUsable"] = usable
    payload["missingPrerequisites"] = missing_prerequisites
    payload["reasonCodes"] = reason_codes
    payload["selectedScorecardId"] = comparisons[0].get("scorecardId") if comparisons else None
    if not comparisons:
        payload["status"] = "blocked"
        payload["classification"] = "candidate_baseline_pair_missing"
    elif blocked_count:
        payload["status"] = "partial"
        payload["classification"] = "multi_candidate_scorecards_partially_blocked"
    elif ready_count == len(comparisons):
        payload["status"] = "ready"
        payload["classification"] = "runtime_injected_multi_candidate_scorecards_ready"
    elif materialized_count == len(comparisons):
        payload["status"] = "materialized"
        payload["classification"] = "multi_candidate_scorecards_materialized"
    else:
        payload["status"] = "planned"
        payload["classification"] = "multi_candidate_scorecards_planned"


def candidate_scorecard_materialized_classification(value: Any) -> str:
    return f"{candidate_scorecard_runtime_blocker(value)}_scorecard_materialized"


def candidate_scorecard_blocked_payload(
    report: JsonObject,
    *,
    classification: str,
    reason: str,
    missing_prerequisite: str,
) -> JsonObject:
    runtime_parameter_injection = report.get("runtimeParameterInjection")
    return {
        "type": "screeps-rl-candidate-vs-baseline-scorecard-readiness",
        "schemaVersion": SCHEMA_VERSION,
        "status": "blocked",
        "classification": classification,
        "scorecardId": None,
        "scorecardArtifactPath": None,
        "runtimeParameterInjection": False,
        "runtimeParameterConsumption": False,
        "injectedVariantCount": runtime_injected_variant_count(runtime_parameter_injection),
        "consumedVariantCount": runtime_consumed_variant_count(runtime_parameter_injection),
        "candidateParameterScope": runtime_parameter_scope(runtime_parameter_injection),
        "scorecardUsable": False,
        "validationScaleComputeBlocked": True,
        "missingPrerequisite": missing_prerequisite,
        "reason": reason,
        "nextAction": "inject candidate parameters into private-simulator runtime inputs before validation-scale compute",
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }


def candidate_scorecard_pair(report: JsonObject) -> tuple[str, str, int | None, int | None] | None:
    pairs = candidate_scorecard_pairs(report)
    return pairs[0] if pairs else None


def candidate_scorecard_pairs(report: JsonObject) -> list[tuple[str, str, int | None, int | None]]:
    ranking = [item for item in report.get("ranking", []) if isinstance(item, dict)]
    if not ranking:
        return []
    incumbent_ids = {item for item in report.get("incumbentStrategyIds", []) if isinstance(item, str)}
    if not incumbent_ids:
        return []
    candidate_items = [item for item in ranking if text_or_none(item.get("variantId")) not in incumbent_ids]
    baseline_items = [item for item in ranking if text_or_none(item.get("variantId")) in incumbent_ids]
    pairs: list[tuple[str, str, int | None, int | None]] = []
    for candidate_item in candidate_items:
        candidate_id = text_or_none(candidate_item.get("variantId"))
        if candidate_id is None:
            continue
        for baseline_item in baseline_items:
            baseline_id = text_or_none(baseline_item.get("variantId"))
            if baseline_id is None:
                continue
            pairs.append(
                (
                    candidate_id,
                    baseline_id,
                    int_or_none(candidate_item.get("rank")),
                    int_or_none(baseline_item.get("rank")),
                )
            )
    return pairs


def candidate_scorecard_runtime_parameter_injection(report: JsonObject, candidate_id: str) -> Any:
    candidate_result = variant_result_by_id(report, candidate_id)
    if isinstance(candidate_result, dict):
        runtime_parameter_injection = candidate_result.get("runtimeParameterInjection")
        if isinstance(runtime_parameter_injection, dict):
            return runtime_parameter_injection
    return report.get("runtimeParameterInjection")


def scorecard_runtime_injection_ready(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    return value.get("runtimeParameterInjection") is True and runtime_injected_variant_count(value) > 0


def scorecard_runtime_consumption_ready(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    return value.get("runtimeParameterConsumption") is True and runtime_consumed_variant_count(value) > 0


def runtime_injected_variant_count(value: Any) -> int:
    if not isinstance(value, dict):
        return 0
    count = int_or_none(value.get("injectedVariantCount"))
    if count is not None and count >= 0:
        return count
    variants = value.get("variants")
    if isinstance(variants, list):
        return sum(
            1
            for row in variants
            if isinstance(row, dict) and row.get("runtimeParameterInjection") is True
        )
    return 1 if value.get("runtimeParameterInjection") is True else 0


def runtime_consumed_variant_count(value: Any) -> int:
    if not isinstance(value, dict):
        return 0
    count = int_or_none(value.get("consumedVariantCount"))
    if count is not None and count >= 0:
        return count
    variants = value.get("variants")
    if isinstance(variants, list):
        return sum(
            1
            for row in variants
            if isinstance(row, dict) and row.get("runtimeParameterConsumption") is True
        )
    return 1 if value.get("runtimeParameterConsumption") is True else 0


def runtime_parameter_scope(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    return text_or_none(value.get("candidateParameterScope"))


def candidate_scorecard_runtime_blocker(value: Any) -> str:
    if not isinstance(value, dict):
        return "runtime_parameter_injection_missing"
    status = text_or_none(value.get("status"))
    scope = runtime_parameter_scope(value)
    if candidate_scorecard_runtime_consumption_missing(value):
        return "runtime_parameter_consumption_missing"
    if status == "metadata_only" or scope == "metadata_only":
        return "runtime_parameter_injection_metadata_only"
    if status == "partial" or scope == "partial_runtime_injection":
        return "runtime_parameter_injection_partial"
    return "runtime_parameter_injection_missing_or_incomplete"


def candidate_scorecard_runtime_blocker_reason(value: Any) -> str:
    if isinstance(value, dict):
        if candidate_scorecard_runtime_consumption_missing(value):
            return "candidate-vs-baseline scorecard requires tick-time runtime policy parameter consumption evidence"
        reason = text_or_none(value.get("reason"))
        if reason is not None:
            return reason
        status = text_or_none(value.get("status"))
        scope = runtime_parameter_scope(value)
        if status == "metadata_only" or scope == "metadata_only":
            return "candidate parameters were metadata-only and were not injected into simulator runtime inputs"
    return "candidate-vs-baseline scorecard requires runtime parameter injection evidence with injectedVariantCount > 0"


def candidate_scorecard_runtime_consumption_missing(value: JsonObject) -> bool:
    scope = runtime_parameter_scope(value)
    consumption_status = text_or_none(value.get("runtimeParameterConsumptionStatus"))
    return (
        scope == "runtime_injected"
        and value.get("runtimeParameterConsumption") is not True
        and runtime_parameter_consumption_blocker_status(consumption_status)
    )


def candidate_scorecard_runtime_missing_prerequisite(value: Any) -> str:
    if isinstance(value, dict) and candidate_scorecard_runtime_consumption_missing(value):
        return "runtime_parameter_consumption"
    return "runtime_parameter_injection"


def candidate_scorecard_runtime_next_action(value: Any) -> str:
    if isinstance(value, dict) and candidate_scorecard_runtime_consumption_missing(value):
        return "emit tick-time runtime policy parameter consumption evidence before promotion"
    return "inject candidate parameters into private-simulator runtime inputs before promotion"


def candidate_scorecard_id(report: JsonObject, candidate_id: str, baseline_id: str) -> str:
    report_id = text_or_none(report.get("reportId")) or "rl-training"
    digest = canonical_hash(
        {
            "baselineStrategyId": baseline_id,
            "candidateStrategyId": candidate_id,
            "reportId": report_id,
            "runtimeParameterInjection": report.get("runtimeParameterInjection"),
            "schemaVersion": SCHEMA_VERSION,
        }
    )[:12]
    return f"rl-scorecard-{safe_artifact_stem(report_id)}-{digest}"


def safe_artifact_stem(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip(".-") or "artifact"


def safe_scorecard_pair_stem(candidate_id: str, baseline_id: str) -> str:
    candidate_stem = safe_artifact_stem(candidate_id)[:96].strip(".-") or "candidate"
    baseline_stem = safe_artifact_stem(baseline_id)[:96].strip(".-") or "baseline"
    digest = canonical_hash({"candidateStrategyId": candidate_id, "baselineStrategyId": baseline_id})[:10]
    return f"{candidate_stem}--vs--{baseline_stem}-{digest}"


def variant_result_by_id(report: JsonObject, variant_id: str) -> JsonObject | None:
    for result in report.get("variantResults", []):
        if isinstance(result, dict) and text_or_none(result.get("variantId")) == variant_id:
            return result
    return None


def role_policy_metadata_for_variant(report: JsonObject, variant_id: str) -> JsonObject:
    result = variant_result_by_id(report, variant_id)
    if isinstance(result, dict):
        return role_policy_lanes.lane_metadata(result)
    for variant in report.get("strategyVariants", []):
        if isinstance(variant, dict) and text_or_none(variant.get("id")) == variant_id:
            return role_policy_lanes.lane_metadata(variant)
    return {}


def scorecard_projection_payload(
    report: JsonObject,
    *,
    result: JsonObject,
    role: str,
    peer_variant_id: str,
    runtime_parameter_injection: Any,
) -> JsonObject:
    variant_id = text_or_none(result.get("variantId")) or "unknown"
    lane_metadata = role_policy_lanes.lane_metadata(result)
    payload: JsonObject = {
        "type": REPORT_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "reportId": f"{text_or_none(report.get('reportId')) or 'rl-training'}-{role}-{variant_id}",
        "sourceTrainingReportId": report.get("reportId"),
        "role": role,
        "candidateId": variant_id if role == "candidate" else peer_variant_id,
        "baselineId": variant_id if role == "baseline" else peer_variant_id,
        "strategyVariantId": variant_id,
        "peerStrategyVariantId": peer_variant_id,
        "policyFamily": lane_metadata.get("policyFamily"),
        "rolePolicy": lane_metadata.get("rolePolicy"),
        "trainingRole": lane_metadata.get("trainingRole"),
        "artifactCount": result.get("sampleCount", 1),
        "metricsByCategory": scorecard_metrics_by_category(result),
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }
    if role == "candidate" and isinstance(runtime_parameter_injection, dict):
        payload["runtimeParameterInjection"] = copy.deepcopy(runtime_parameter_injection)
    return payload


def scorecard_metrics_by_category(result: JsonObject) -> JsonObject:
    reward_tuple = policy_reward_tuple_values(result) or []
    metrics = result.get("metrics") if isinstance(result.get("metrics"), dict) else {}
    reliability = metrics.get("reliability") if isinstance(metrics.get("reliability"), dict) else {}
    territory = metrics.get("territory") if isinstance(metrics.get("territory"), dict) else {}
    resources = metrics.get("resources") if isinstance(metrics.get("resources"), dict) else {}
    kills = metrics.get("kills") if isinstance(metrics.get("kills"), dict) else {}
    objective_signal = metrics.get("objectiveSignal") if isinstance(metrics.get("objectiveSignal"), dict) else {}
    return {
        "reliability": {
            "value": reward_tuple[0] if len(reward_tuple) > 0 else 0,
            "score": reliability.get("score"),
        },
        "territory": {
            "value": reward_tuple[1] if len(reward_tuple) > 1 else 0,
            "ownedRoomCount": territory.get("ownedRoomCount"),
            "rclDelta": territory.get("rclDelta"),
            "survivedEndRoomCount": len(territory.get("survivedEndRooms", []))
            if isinstance(territory.get("survivedEndRooms"), list)
            else None,
        },
        "resources": {
            "value": reward_tuple[2] if len(reward_tuple) > 2 else 0,
            "raw": resources.get("raw"),
            "storedEnergyDelta": resources.get("storedEnergyDelta"),
            "collectedEnergy": resources.get("collectedEnergy"),
            "spawnUtilization": resources.get("spawnUtilization"),
        },
        "kills": {
            "value": reward_tuple[3] if len(reward_tuple) > 3 else 0,
            "delta": kills.get("delta"),
            "hostileKills": kills.get("hostileKills"),
            "ownLosses": kills.get("ownLosses"),
            "finalHostileCreeps": objective_signal.get("finalHostileCreeps"),
        },
    }


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


def multi_tier_policy_activation_fixture_room_summaries(
    scenario: JsonObject | None,
    config: SimulationConfig,
) -> dict[str, JsonObject]:
    map_source_file = multi_tier_policy_activation_fixture_map_source_file(scenario, config)
    if map_source_file is None:
        return {}
    return simulator_harness._private_map_fixture_room_summaries(map_source_file)


def multi_tier_policy_activation_fixture_loader(
    scenario: JsonObject | None,
    config: SimulationConfig,
) -> MultiTierPolicyActivationFixtureLoader | None:
    map_source_file = multi_tier_policy_activation_fixture_map_source_file(scenario, config)
    if map_source_file is None:
        return None
    cached: tuple[dict[str, JsonObject], str | None] | None = None

    def load() -> tuple[dict[str, JsonObject], str | None]:
        nonlocal cached
        if cached is None:
            cached = (
                simulator_harness._private_map_fixture_room_summaries(map_source_file),
                multi_tier_policy_activation_anchor_room(scenario, config),
            )
        return cached

    return load


def multi_tier_policy_activation_fixture_map_source_file(
    scenario: JsonObject | None,
    config: SimulationConfig,
) -> Path | None:
    if not scenario_supports_multi_tier_policy_comparison(scenario):
        return None
    config_map_source = resolve_multi_tier_map_source_path(config.map_source_file)
    evidence = scenario.get("evidence") if isinstance(scenario, dict) else None
    evidence_map_source_text = None
    if isinstance(evidence, dict):
        evidence_map_source_text = text_or_none(evidence.get("map_source_file")) or text_or_none(evidence.get("mapSourceFile"))
    if evidence_map_source_text is None:
        return config_map_source
    evidence_map_source = resolve_multi_tier_map_source_path(Path(evidence_map_source_text))
    if evidence_map_source.resolve(strict=False) != config_map_source.resolve(strict=False):
        raise TrainingCardError("multi-tier scenario evidence.map_source_file must match simulation.map_source_file")
    return evidence_map_source


def resolve_multi_tier_map_source_path(map_source_file: Path) -> Path:
    expanded = map_source_file.expanduser()
    if expanded.is_absolute():
        return expanded
    return REPO_ROOT / expanded


def multi_tier_policy_activation_anchor_room(
    scenario: JsonObject | None,
    config: SimulationConfig,
) -> str | None:
    evidence = scenario.get("evidence") if isinstance(scenario, dict) else None
    if isinstance(evidence, dict):
        anchor_room = text_or_none(evidence.get("anchor_room")) or text_or_none(evidence.get("anchorRoom"))
        if anchor_room is not None:
            return anchor_room
    return config.room


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
    *,
    multi_tier_fixture_room_summaries: dict[str, JsonObject] | None = None,
    multi_tier_anchor_room: str | None = None,
    multi_tier_fixture_loader: MultiTierPolicyActivationFixtureLoader | None = None,
) -> JsonObject:
    run_metrics_by_attempt: list[JsonObject | None] = []
    successful_runs: list[JsonObject] = []
    for run in runs:
        if run.get("ok") is True:
            finalized_run = finalize_multi_tier_policy_activation_run(
                run,
                variant=variant,
                fixture_room_summaries=multi_tier_fixture_room_summaries,
                anchor_room=multi_tier_anchor_room,
                fixture_loader=multi_tier_fixture_loader,
            )
            successful_runs.append(finalized_run)
            run_metrics_by_attempt.append(compute_run_metrics(finalized_run, reward_options))
        else:
            run_metrics_by_attempt.append(None)
    run_metrics = [metrics for metrics in run_metrics_by_attempt if metrics is not None]
    excluded_run_count = len(runs) - len(run_metrics)
    reward_tuple = mean_reward_tuple(run_metrics)
    reward_tuple[0] = reliability_score(scored_run_count=len(run_metrics), total_run_count=len(runs))
    metrics = aggregate_metrics(run_metrics)
    metrics["reliability"]["score"] = reward_tuple[0]
    activation_samples = [
        multi_tier_activation_metric_evidence(metric, sample_index=index)
        for index, metric in enumerate(run_metrics)
    ]
    activation_traces = [
        multi_tier_activation_sample_trace(
            run=run,
            variant=variant,
            activation_evidence=activation_samples[index],
            sample_index=index,
        )
        for index, run in enumerate(successful_runs)
    ]
    runtime_parameter_injection = summarize_variant_runtime_parameter_injection(variant, runs)
    reward_sample_values = reward_samples(run_metrics_by_attempt)
    reward_sample_stddev_values = reward_sample_stddev(run_metrics_by_attempt)
    scalar_reward = build_scalar_weighted_reward_summary(
        reward_tuple=reward_tuple,
        reward_samples=reward_sample_values,
        activation_samples=activation_samples,
        activation_traces=activation_traces,
        metrics_by_attempt=run_metrics_by_attempt,
        reward_options=reward_options,
    )
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
            "samples": reward_sample_values,
            "sampleStdDev": reward_sample_stddev_values,
        },
        "metrics": metrics,
        "multiTierActivationSamples": activation_samples,
        "multiTierActivationTraces": activation_traces,
        "runtimeParameterInjection": runtime_parameter_injection,
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
    if scalar_reward is not None:
        summary["reward"]["scalarWeightedSum"] = scalar_reward
        summary["scalarWeightedReward"] = copy.deepcopy(scalar_reward)
    if variant.policy_family:
        summary["policyFamily"] = variant.policy_family
    if variant.role_policy:
        summary["rolePolicy"] = variant.role_policy
    if variant.candidate_policy_id:
        summary["candidatePolicyId"] = variant.candidate_policy_id
    if variant.source_strategy_id:
        summary["sourceStrategyId"] = variant.source_strategy_id
    if variant.parameter_evidence is not None:
        summary["parameterEvidence"] = copy.deepcopy(variant.parameter_evidence)
    evaluated_parameters = runtime_parameter_injection.get("evaluatedParameters")
    if runtime_parameter_injection.get("runtimeParameterInjection") is True and isinstance(evaluated_parameters, dict):
        summary["evaluatedParameters"] = copy.deepcopy(evaluated_parameters)
    if variant.training_role:
        summary["trainingRole"] = variant.training_role
    return summary


def build_scalar_weighted_reward_summary(
    *,
    reward_tuple: Sequence[Any],
    reward_samples: Sequence[Sequence[Any]],
    activation_samples: Sequence[JsonObject],
    activation_traces: Sequence[JsonObject],
    metrics_by_attempt: Sequence[JsonObject | None],
    reward_options: JsonObject,
) -> JsonObject | None:
    if reward_options.get("scalarWeightedSumAuthorized") is not True:
        return None
    weight_evidence = reward_options.get("scalarWeightEvidence")
    if not isinstance(weight_evidence, dict):
        return None
    weights = weight_evidence.get("normalizedWeightsByRewardTier")
    if not isinstance(weights, dict):
        return None

    activation_by_attempt: list[JsonObject | None] = []
    trace_by_attempt: list[JsonObject | None] = []
    successful_index = 0
    for metrics in metrics_by_attempt:
        if metrics is None:
            activation_by_attempt.append(None)
            trace_by_attempt.append(None)
            continue
        activation_by_attempt.append(
            activation_samples[successful_index] if successful_index < len(activation_samples) else None
        )
        trace_by_attempt.append(
            activation_traces[successful_index] if successful_index < len(activation_traces) else None
        )
        successful_index += 1

    activation_scores: list[float | int] = []
    scalar_samples: list[float | int] = []
    sample_components: list[JsonObject] = []
    for sample_index, raw_sample in enumerate(reward_samples):
        reward_sample = policy_return_tuple_from_sequence(list(raw_sample))
        if reward_sample is None:
            reward_sample = [0 for _tier in REWARD_TIERS]
        activation_sample = (
            activation_by_attempt[sample_index] if sample_index < len(activation_by_attempt) else None
        )
        trace = trace_by_attempt[sample_index] if sample_index < len(trace_by_attempt) else None
        activation_score = scalar_activation_score(activation_sample, trace)
        activation_scores.append(round_policy_number(activation_score))
        components = scalar_reward_component_values(reward_sample, activation_score)
        weighted = scalar_weighted_components(components, weights)
        scalar_value = round_policy_number(sum(float(value) for value in weighted.values()))
        scalar_samples.append(scalar_value)
        sample_components.append({
            "sampleIndex": sample_index,
            "componentValuesByRewardTier": components,
            "weightedComponentsByRewardTier": weighted,
            "scalarReward": scalar_value,
        })

    aggregate_components = scalar_reward_component_values(
        policy_return_tuple_from_sequence(list(reward_tuple)) or [0 for _tier in REWARD_TIERS],
        statistics.fmean(float(value) for value in activation_scores) if activation_scores else 0.0,
    )
    aggregate_weighted = scalar_weighted_components(aggregate_components, weights)
    scalar_reward = round_policy_number(sum(float(value) for value in aggregate_weighted.values()))
    return {
        "type": POLICY_GRADIENT_SCALAR_REWARD,
        "authorized": True,
        "use": reward_options.get("scalarWeightedSumUse") or SCALAR_WEIGHTED_SUM_AUTHORIZED_USE,
        "rankingRewardModel": POLICY_GRADIENT_LEXICOGRAPHIC_REWARD,
        "componentOrder": list(SCALAR_WEIGHTED_REWARD_TIERS),
        "componentValuesByRewardTier": aggregate_components,
        "sourceComponentWeights": copy.deepcopy(weight_evidence.get("sourceComponentWeights")),
        "normalizedWeightsByRewardTier": copy.deepcopy(weights),
        "weightedComponentsByRewardTier": aggregate_weighted,
        "scalarReward": scalar_reward,
        "scalarReturnSamples": scalar_samples,
        "activationScore": aggregate_components["activation"],
        "activationScoreSamples": activation_scores,
        "sampleComponents": sample_components,
        "sampleCount": len(scalar_samples),
        "promotionUse": "blocked_until_trusted_samples_and_loop_b_advantage_gate",
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }


def scalar_activation_score(sample: JsonObject | None, trace: JsonObject | None) -> float:
    if isinstance(trace, dict):
        policy_activation = trace.get("policyActivation")
        if isinstance(policy_activation, dict):
            score = number_or_none(policy_activation.get("activationScore"))
            if score is not None:
                return float(score)
    if isinstance(sample, dict):
        score = number_or_none(sample.get("activationScore"))
        if score is not None:
            return float(score)
    return 0.0


def scalar_reward_component_values(
    reward_tuple: Sequence[Any],
    activation_score: float | int,
) -> JsonObject:
    components: JsonObject = {}
    for index, tier in enumerate(REWARD_TIERS):
        value = number_or_none(reward_tuple[index]) if index < len(reward_tuple) else None
        components[tier] = round_policy_number(float(value) if value is not None else 0.0)
    components["activation"] = round_policy_number(float(activation_score))
    return components


def scalar_weighted_components(components: JsonObject, weights: JsonObject) -> JsonObject:
    return {
        tier: round_policy_number(float(components.get(tier, 0)) * float(weights.get(tier, 0)))
        for tier in SCALAR_WEIGHTED_REWARD_TIERS
    }


def multi_tier_activation_sample_trace(
    *,
    run: JsonObject,
    variant: StrategyVariant,
    activation_evidence: JsonObject,
    sample_index: int,
) -> JsonObject:
    activation = json_object_or_none(run.get("policyActivation"))
    metrics = json_object_or_none(run.get("metrics")) or {}
    projected_activation = json_object_or_none(metrics.get("policyActivation"))
    scenario = json_object_or_none(run.get("scenario")) or {}
    code_artifact = json_object_or_none(scenario.get("codeArtifact")) or {}
    map_artifact = json_object_or_none(scenario.get("mapArtifact")) or {}
    projected_evidence = json_object_or_none(activation.get("projectedEvidence")) if activation is not None else None
    observed_evidence = json_object_or_none(activation.get("observedEvidence")) if activation is not None else None
    policy_activation = activation if activation is not None else projected_activation
    trace: JsonObject = {
        "sampleIndex": sample_index,
        "variantRunId": run.get("variant_run_id", run.get("variantRunId")),
        "ticksRun": number_or_none(run.get("ticks_run", run.get("ticksRun"))),
        "ok": run.get("ok") is True,
        "strategyVariantId": variant.id,
        "candidatePolicyId": variant.candidate_policy_id,
        "sourceStrategyId": variant.source_strategy_id,
        "parameterHash": canonical_hash(variant.parameters),
        "activationEvidence": copy.deepcopy(activation_evidence),
        "policyActivationPresent": policy_activation is not None,
        "metricsSource": "simulator_policy_activation"
        if activation is not None
        else ("projected_policy_activation" if projected_activation is not None else "raw_metric_reduction"),
        "scenario": {
            "runId": scenario.get("runId"),
            "room": scenario.get("room"),
            "shard": scenario.get("shard"),
            "activeWorldBranch": scenario.get("activeWorldBranch"),
            "codeSha256": code_artifact.get("sha256"),
            "codePath": code_artifact.get("path"),
            "mapSha256": map_artifact.get("sha256"),
            "mapSourcePath": map_artifact.get("sourcePath"),
        },
    }
    if policy_activation is not None:
        trace_policy_activation = {
            "type": policy_activation.get("type"),
            "policyAction": policy_activation.get("policyAction"),
            "executionAction": policy_activation.get("executionAction"),
            "objectiveSignalSource": policy_activation.get("objectiveSignalSource"),
            "targetRoom": policy_activation.get("targetRoom"),
            "anchorRoom": policy_activation.get("anchorRoom"),
            "activationScore": policy_activation.get("activationScore"),
            "threshold": policy_activation.get("threshold"),
            "reason": policy_activation.get("reason"),
        }
        activation_metrics = projected_activation if projected_activation is not None else policy_activation
        for field in (
            "hostileKills",
            "hostileKillsSource",
            "projectedHostileKills",
            "observedHostileKills",
            "territoryDelta",
            "territoryDeltaSource",
            "projectedTerritoryDelta",
            "observedTerritoryDelta",
        ):
            if field in activation_metrics:
                trace_policy_activation[field] = activation_metrics.get(field)
        trace["policyActivation"] = trace_policy_activation
        evidence_warnings = policy_activation.get("evidenceWarnings")
        if isinstance(evidence_warnings, list):
            trace["evidenceWarnings"] = copy.deepcopy(evidence_warnings[:5])
    if projected_evidence is not None:
        trace["projectedEvidence"] = {
            "mode": projected_evidence.get("mode"),
            "targetRoom": projected_evidence.get("targetRoom"),
            "initialHostileCount": projected_evidence.get("initialHostileCount"),
            "finalHostileCount": projected_evidence.get("finalHostileCount"),
            "projectedHostileKills": projected_evidence.get("projectedHostileKills"),
            "projectedTerritoryDelta": projected_evidence.get("projectedTerritoryDelta"),
            "controllerClaimed": projected_evidence.get("controllerClaimed"),
            "fixtureGeneratedRoomState": projected_evidence.get("fixtureGeneratedRoomState"),
        }
    if observed_evidence is not None:
        trace["observedEvidence"] = {
            "targetRoom": observed_evidence.get("targetRoom"),
            "observedTickCount": observed_evidence.get("observedTickCount"),
            "initialTick": observed_evidence.get("initialTick"),
            "finalTick": observed_evidence.get("finalTick"),
            "initialHostileCount": observed_evidence.get("initialHostileCount"),
            "finalHostileCount": observed_evidence.get("finalHostileCount"),
            "hostileCountReduced": observed_evidence.get("hostileCountReduced"),
            "controllerClaimed": observed_evidence.get("controllerClaimed"),
            "ownPresenceIncreased": observed_evidence.get("ownPresenceIncreased"),
            "fixtureGeneratedRoomState": observed_evidence.get("fixtureGeneratedRoomState"),
        }
    return trace


def runtime_parameter_consumption_from_run(run: JsonObject) -> JsonObject | None:
    consumption = run.get("runtimeParameterConsumption")
    if isinstance(consumption, dict):
        return consumption

    nested_injection = run.get("runtimeParameterInjection")
    if isinstance(nested_injection, dict):
        nested_consumption = nested_injection.get("runtimeParameterConsumptionEvidence")
        if isinstance(nested_consumption, dict):
            return nested_consumption

    return None


def runtime_evaluated_parameter_source(run: JsonObject) -> tuple[str, Any] | None:
    consumption = runtime_parameter_consumption_from_run(run)
    if isinstance(consumption, dict) and consumption.get("runtimeParameterConsumption") is True:
        parameters = consumption.get("evaluatedParameters")
        if isinstance(parameters, dict):
            return "runtimeParameterConsumption.evaluatedParameters", parameters

    source = text_or_none(run.get("evaluatedParametersSource", run.get("evaluated_parameters_source")))
    if source in {
        "runtime_parameter_consumption",
        "runtime_policy_parameter_consumption",
        "Memory.rlRuntimePolicyParameters",
        simulator_harness.RUNTIME_PARAMETER_CONSUMPTION_GLOBAL,
    }:
        for field in ("evaluatedParameters", "evaluated_parameters"):
            if field in run:
                return field, run.get(field)
    return None


def runtime_parameter_scope_indicates_runtime_attempt(row: JsonObject) -> bool:
    scope = text_or_none(row.get("candidateParameterScope"))
    status = text_or_none(row.get("status"))
    return (
        row.get("runtimeParameterInjection") is True
        or scope in {"runtime_injected", "partial_runtime_injection"}
        or status
        in {
            "prepared",
            "injected",
            "failed",
            "not_attempted",
            "missing_evaluated_parameters",
            "invalid_evaluated_parameters",
            "evaluated_parameter_mismatch",
            "partial",
        }
    )


def summarize_runtime_parameter_injection_attempt(
    *,
    variant: StrategyVariant,
    run: JsonObject,
    index: int,
) -> JsonObject:
    injection = run.get("runtimeParameterInjection")
    variant_run_id = run.get("variant_run_id", run.get("variantRunId"))
    run_ok = run.get("ok") is True
    if not isinstance(injection, dict):
        return {
            "runIndex": index,
            "variantRunId": variant_run_id,
            "status": "missing",
            "runtimeParameterInjection": False,
            "candidateParameterScope": "metadata_only",
            "reason": "simulator run did not include runtime parameter injection evidence",
        }

    row: JsonObject = {
        "runIndex": index,
        "variantRunId": variant_run_id,
        "status": injection.get("status"),
        "runtimeParameterInjection": False,
        "candidateParameterScope": injection.get("candidateParameterScope"),
        "candidatePolicyId": injection.get("candidatePolicyId"),
        "sourceStrategyId": injection.get("sourceStrategyId"),
        "family": injection.get("family"),
        "parametersSha256": injection.get("parametersSha256"),
        "reason": injection.get("reason"),
    }
    if injection.get("runtimeParameterInjection") is not True:
        return {key: value for key, value in row.items() if value is not None}

    if not run_ok:
        row["status"] = "failed"
        row["reason"] = text_or_none(run.get("error")) or (
            "simulator attempt failed before runtime-injected parameters could become eligible evidence"
        )
        return {key: value for key, value in row.items() if value is not None}

    row["runtimeParameterInjection"] = True

    consumption = runtime_parameter_consumption_from_run(run)
    if isinstance(consumption, dict):
        row["runtimeParameterConsumption"] = consumption.get("runtimeParameterConsumption") is True
        row["runtimeParameterConsumptionStatus"] = consumption.get("status")
        row["runtimeParameterConsumptionSource"] = consumption.get("source")
        row["runtimeParameterConsumer"] = consumption.get("consumerMarker")
        row["runtimeParameterConsumerVersion"] = consumption.get("consumerVersion")
        row["consumedParametersSha256"] = consumption.get("consumedParametersSha256")
        row["consumedStrategyVariantId"] = consumption.get("consumedStrategyVariantId")
        row["consumedTick"] = consumption.get("consumedTick")
        applied_strategy_ids = consumption.get("appliedStrategyIds")
        if isinstance(applied_strategy_ids, list):
            row["appliedStrategyIds"] = [
                strategy_id for strategy_id in applied_strategy_ids if isinstance(strategy_id, str)
            ]

    if not isinstance(consumption, dict) or consumption.get("runtimeParameterConsumption") is not True:
        consumption_status = text_or_none(consumption.get("status")) if isinstance(consumption, dict) else None
        if consumption_status in (None, "missing"):
            consumption_status = "missing_runtime_parameter_consumption"
        row["runtimeParameterConsumptionStatus"] = consumption_status
        row["status"] = consumption_status
        row["reason"] = (
            text_or_none(consumption.get("reason")) if isinstance(consumption, dict) else None
        ) or "successful simulator attempt did not report consumed runtime policy parameter evidence"
        return {key: value for key, value in row.items() if value is not None}

    source = runtime_evaluated_parameter_source(run)
    if source is None:
        row["runtimeParameterConsumption"] = False
        row["runtimeParameterConsumptionStatus"] = "missing_evaluated_parameters"
        if isinstance(consumption, dict) and text_or_none(consumption.get("reason")):
            row["status"] = text_or_none(consumption.get("status")) or "missing_evaluated_parameters"
            row["reason"] = text_or_none(consumption.get("reason"))
        else:
            row["status"] = "missing_evaluated_parameters"
            row["reason"] = "successful simulator attempt did not report evaluatedParameters from runtime consumption evidence"
        return {key: value for key, value in row.items() if value is not None}

    field, raw_parameters = source
    if not isinstance(raw_parameters, dict):
        row["runtimeParameterConsumption"] = False
        row["runtimeParameterConsumptionStatus"] = "invalid_evaluated_parameters"
        row["status"] = "invalid_evaluated_parameters"
        row["reason"] = f"successful simulator attempt reported non-object evaluated parameters in {field}"
        return {key: value for key, value in row.items() if value is not None}

    evaluated_parameters = copy.deepcopy(raw_parameters)
    evaluated_hash = runtime_parameter_parameters_hash(evaluated_parameters)
    injected_hash = text_or_none(injection.get("parametersSha256"))
    card_hash = runtime_parameter_parameters_hash(variant.parameters)
    if injected_hash is not None and evaluated_hash != injected_hash:
        row["runtimeParameterInjection"] = False
        row["runtimeParameterConsumption"] = False
        row["runtimeParameterConsumptionStatus"] = "evaluated_parameter_mismatch"
        row["status"] = "evaluated_parameter_mismatch"
        row["reason"] = "successful simulator attempt evaluatedParameters disagreed with injected parameters"
        row["evaluatedParametersSha256"] = evaluated_hash
        return {key: value for key, value in row.items() if value is not None}
    if evaluated_hash != card_hash:
        row["runtimeParameterInjection"] = False
        row["runtimeParameterConsumption"] = False
        row["runtimeParameterConsumptionStatus"] = "evaluated_parameter_mismatch"
        row["status"] = "evaluated_parameter_mismatch"
        row["reason"] = "successful simulator attempt evaluatedParameters disagreed with the strategy variant parameters"
        row["evaluatedParametersSha256"] = evaluated_hash
        return {key: value for key, value in row.items() if value is not None}

    row["status"] = "injected"
    row["evaluatedParameters"] = evaluated_parameters
    row["evaluatedParametersSource"] = field
    row["evaluatedParametersSha256"] = evaluated_hash
    row.pop("reason", None)
    return {key: value for key, value in row.items() if value is not None}


def summarize_variant_runtime_parameter_injection(
    variant: StrategyVariant,
    runs: Sequence[JsonObject],
) -> JsonObject:
    attempts: list[JsonObject] = []
    successful_attempts: list[JsonObject] = []
    for index, run in enumerate(runs):
        if isinstance(run, dict):
            row = summarize_runtime_parameter_injection_attempt(variant=variant, run=run, index=index)
        else:
            row = {
                "runIndex": index,
                "variantRunId": None,
                "status": "missing",
                "runtimeParameterInjection": False,
                "candidateParameterScope": "metadata_only",
                "reason": "simulator run did not include runtime parameter injection evidence",
            }
        attempts.append(row)
        if isinstance(run, dict) and run.get("ok") is True:
            successful_attempts.append(row)

    if not attempts:
        return {
            "type": simulator_harness.RUNTIME_PARAMETER_INJECTION_TYPE,
            "schemaVersion": SCHEMA_VERSION,
            "strategyVariantId": variant.id,
            "status": "missing",
            "runtimeParameterInjection": False,
            "inlineCandidatesRuntimeInjected": False,
            "candidateParameterScope": "metadata_only",
            "reason": "variant had no simulator run attempts",
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }

    if not successful_attempts:
        attempted_runtime = any(runtime_parameter_scope_indicates_runtime_attempt(row) for row in attempts)
        first_reason = next((row.get("reason") for row in attempts if row.get("reason")), None)
        status = "not_injected" if attempted_runtime else "metadata_only"
        scope = "runtime_injected" if attempted_runtime else "metadata_only"
        reason = (
            str(first_reason)
            if first_reason
            else (
                "variant had no successful simulator attempts with runtime parameter evidence"
                if attempted_runtime
                else "candidate parameters were not injected into simulator runtime inputs"
            )
        )
        payload = {
            "type": simulator_harness.RUNTIME_PARAMETER_INJECTION_TYPE,
            "schemaVersion": SCHEMA_VERSION,
            "strategyVariantId": variant.id,
            "candidatePolicyId": variant.candidate_policy_id,
            "status": status,
            "runtimeParameterInjection": False,
            "inlineCandidatesRuntimeInjected": False,
            "candidateParameterScope": scope,
            "mechanism": simulator_harness.RUNTIME_PARAMETER_INJECTION_MECHANISM,
            "attemptCount": len(attempts),
            "successfulAttemptCount": 0,
            "attempts": attempts,
            "parametersSha256": runtime_parameter_parameters_hash(variant.parameters),
            "reason": reason,
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        return {key: value for key, value in payload.items() if value is not None}

    eligible_attempts = successful_attempts
    injected = [row for row in eligible_attempts if row.get("runtimeParameterInjection") is True]
    consumed_attempt_count = sum(
        1
        for row in eligible_attempts
        if row.get("runtimeParameterInjection") is True and row.get("runtimeParameterConsumption") is True
    )
    complete_transport_without_consumption = (
        eligible_attempts
        and len(injected) == len(eligible_attempts)
        and consumed_attempt_count == 0
        and all(
            runtime_parameter_transport_without_consumption_status(row.get("status"))
            for row in eligible_attempts
        )
    )
    if eligible_attempts and len(injected) == len(eligible_attempts) and consumed_attempt_count == len(eligible_attempts):
        status = "injected"
        runtime_injected = True
        scope = "runtime_injected"
        evaluated_parameters = copy.deepcopy(injected[0].get("evaluatedParameters"))
        reason = None
    elif complete_transport_without_consumption:
        status = "injected"
        runtime_injected = True
        scope = "runtime_injected"
        evaluated_parameters = None
        reason = (
            "runtime-injected parameters were uploaded, but successful simulator attempts did not all "
            "report consumed runtime policy parameter evidence"
        )
    elif injected:
        status = "partial"
        first_reason = next((row.get("reason") for row in eligible_attempts if row.get("reason")), None)
        reason = str(first_reason) if first_reason else (
            "not every successful simulator attempt included consumed runtime parameter evidence"
        )
        runtime_injected = False
        scope = "partial_runtime_injection"
        evaluated_parameters = None
    else:
        attempted_runtime = any(runtime_parameter_scope_indicates_runtime_attempt(row) for row in attempts)
        status = "not_injected" if attempted_runtime else "metadata_only"
        first_reason = next((row.get("reason") for row in eligible_attempts if row.get("reason")), None)
        reason = (
            str(first_reason)
            if first_reason
            else (
                "simulator attempts did not inject candidate parameters"
                if attempted_runtime
                else "candidate parameters were not injected into simulator runtime inputs"
            )
        )
        runtime_injected = False
        scope = "runtime_injected" if attempted_runtime else "metadata_only"
        evaluated_parameters = None

    candidate_policy_id = variant.candidate_policy_id or first_attempt_text(attempts, "candidatePolicyId")
    source_strategy_id = variant.source_strategy_id or first_attempt_text(attempts, "sourceStrategyId")
    family = variant.family or first_attempt_text(attempts, "family")
    payload: JsonObject = {
        "type": simulator_harness.RUNTIME_PARAMETER_INJECTION_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "strategyVariantId": variant.id,
        "candidatePolicyId": candidate_policy_id,
        "sourceStrategyId": source_strategy_id,
        "family": family,
        "status": status,
        "runtimeParameterInjection": runtime_injected,
        "inlineCandidatesRuntimeInjected": runtime_injected,
        "candidateParameterScope": scope,
        "mechanism": simulator_harness.RUNTIME_PARAMETER_INJECTION_MECHANISM,
        "attemptCount": len(attempts),
        "successfulAttemptCount": len(successful_attempts),
        "attempts": attempts,
        "parametersSha256": runtime_parameter_parameters_hash(variant.parameters),
        "runtimeParameterConsumption": runtime_injected and consumed_attempt_count == len(eligible_attempts),
        "runtimeParameterConsumptionStatus": runtime_parameter_consumption_rollup_status(eligible_attempts),
        "consumedAttemptCount": consumed_attempt_count,
        "policyUpdateEligible": runtime_injected and consumed_attempt_count == len(eligible_attempts),
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
    }
    if reason:
        payload["reason"] = reason
    if runtime_injected and isinstance(evaluated_parameters, dict):
        payload["evaluatedParameters"] = evaluated_parameters
        first_injected = injected[0]
        for field in (
            "runtimeParameterConsumptionSource",
            "runtimeParameterConsumer",
            "runtimeParameterConsumerVersion",
            "evaluatedParametersSource",
            "evaluatedParametersSha256",
            "consumedParametersSha256",
            "consumedStrategyVariantId",
            "consumedTick",
            "appliedStrategyIds",
        ):
            if field in first_injected:
                payload[field] = copy.deepcopy(first_injected.get(field))
    return {key: value for key, value in payload.items() if value is not None}


def first_attempt_text(attempts: Sequence[JsonObject], field: str) -> str | None:
    for attempt in attempts:
        value = text_or_none(attempt.get(field))
        if value is not None:
            return value
    return None


def finalize_multi_tier_policy_activation_run(
    run: JsonObject,
    *,
    variant: StrategyVariant,
    fixture_room_summaries: dict[str, JsonObject] | None = None,
    anchor_room: str | None = None,
    fixture_loader: MultiTierPolicyActivationFixtureLoader | None = None,
) -> JsonObject:
    tick_log = run.get("tick_log", run.get("tickLog"))
    ticks = [copy.deepcopy(tick) for tick in tick_log if isinstance(tick, dict)] if isinstance(tick_log, list) else []
    activation = run.get("policyActivation")
    metrics = run.get("metrics") if isinstance(run.get("metrics"), dict) else None
    fixture_merged = False

    def ensure_fixture_room_summaries() -> dict[str, JsonObject]:
        nonlocal anchor_room, fixture_merged, fixture_room_summaries
        if fixture_room_summaries is None:
            if fixture_loader is None:
                fixture_room_summaries = {}
            else:
                fixture_room_summaries, loaded_anchor_room = fixture_loader()
                if anchor_room is None:
                    anchor_room = loaded_anchor_room
        if fixture_room_summaries and ticks and not fixture_merged:
            for tick_entry in ticks:
                simulator_harness._merge_fixture_room_summaries_into_tick(tick_entry, fixture_room_summaries)
            fixture_merged = True
        return fixture_room_summaries or {}

    if not isinstance(activation, dict):
        if len(ticks) < 2:
            return run
        loaded_fixture_room_summaries = ensure_fixture_room_summaries()
        if not loaded_fixture_room_summaries:
            return run
        allow_offline_projection = simulator_harness._tick_log_has_fixture_generated_rooms(ticks)
        activation = simulator_harness.build_multi_tier_policy_activation_evidence(
            ticks,
            variant.to_json(),
            loaded_fixture_room_summaries,
            anchor_room=anchor_room,
            run_errors=run.get("errors") if isinstance(run.get("errors"), list) else (),
            evidence_errors=run.get("evidenceErrors") if isinstance(run.get("evidenceErrors"), list) else (),
            allow_offline_projection=allow_offline_projection,
        )
    if not isinstance(activation, dict):
        return run

    if metrics is None:
        if not ticks:
            return run
        ensure_fixture_room_summaries()
        metrics = simulator_harness.build_variant_metrics(ticks)
    finalized = dict(run)
    if ticks:
        finalized["tick_log"] = ticks
        if "tickLog" in finalized:
            finalized["tickLog"] = ticks
    finalized["policyActivation"] = activation
    finalized["metrics"] = simulator_harness.project_multi_tier_policy_activation_metrics(metrics, activation)
    return finalized


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
        if controller.get("my") is False or controller.get("owned") is False:
            return False
        owner = controller.get("owner")
        if isinstance(owner, str) and owner in {"me", "self", "owned"}:
            return True
        if isinstance(owner, str) and owner.strip():
            return True
        if isinstance(owner, dict) and any(text_or_none(owner.get(key)) for key in ("username", "name", "id", "_id")):
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


def json_object_or_none(value: Any) -> JsonObject | None:
    return value if isinstance(value, dict) else None


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
        if isinstance(result.get("policyFamily"), str):
            ranking[-1]["policyFamily"] = result["policyFamily"]
        if isinstance(result.get("rolePolicy"), str):
            ranking[-1]["rolePolicy"] = result["rolePolicy"]
        if isinstance(result.get("trainingRole"), str):
            ranking[-1]["trainingRole"] = result["trainingRole"]
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
                "policyFamily": item.get("policyFamily"),
                "rolePolicy": item.get("rolePolicy"),
                "trainingRole": item.get("trainingRole"),
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


def build_multi_tier_activation_audit(
    *,
    card: JsonObject,
    variants: Sequence[StrategyVariant],
    config: SimulationConfig,
    scenario: JsonObject | None,
    report_id: str,
    generated_at: str,
) -> JsonObject:
    evidence = scenario.get("evidence") if isinstance(scenario, dict) else {}
    if not isinstance(evidence, dict):
        evidence = {}
    scenario_id = (
        text_or_none(scenario.get("scenario_id")) or text_or_none(scenario.get("scenarioId"))
        if isinstance(scenario, dict)
        else None
    )
    fixture_sha256 = text_or_none(evidence.get("fixture_sha256")) or text_or_none(evidence.get("fixtureSha256"))
    code_commit = text_or_none(card.get("code_commit")) or text_or_none(card.get("codeCommit"))
    strategy_variant_fingerprint = [
        {
            "id": variant.id,
            "candidatePolicyId": variant.candidate_policy_id,
            "sourceStrategyId": variant.source_strategy_id,
            "parameterHash": canonical_hash(variant.parameters),
        }
        for variant in variants
    ]
    comparison_seed: JsonObject = {
        "activationImplementation": MULTI_TIER_ACTIVATION_IMPLEMENTATION,
        "codeCommit": code_commit,
        "scenarioId": scenario_id,
        "mapSourceFile": str(config.map_source_file),
        "fixtureSha256": fixture_sha256,
        "room": config.room,
        "shard": config.shard,
        "branch": config.branch,
        "ticks": config.ticks,
        "strategyVariantFingerprint": strategy_variant_fingerprint,
    }
    return {
        "type": MULTI_TIER_ACTIVATION_AUDIT_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "reportId": report_id,
        "generatedAt": generated_at,
        "activationImplementation": MULTI_TIER_ACTIVATION_IMPLEMENTATION,
        "comparisonKey": canonical_hash(comparison_seed),
        "comparisonKeyFields": sorted(comparison_seed),
        "sameScenarioMapRequiresSameCodeCommit": True,
        "codeCommit": code_commit,
        "scenarioId": scenario_id,
        "mapSourceFile": str(config.map_source_file),
        "fixtureSha256": fixture_sha256,
        "room": config.room,
        "shard": config.shard,
        "branch": config.branch,
        "ticks": config.ticks,
        "strategyVariantIds": [variant.id for variant in variants],
        "strategyVariantFingerprint": strategy_variant_fingerprint,
    }


def build_multi_tier_activation_proof(
    *,
    results: Sequence[JsonObject],
    scenario: JsonObject | None,
    kpi_summary: JsonObject,
    audit: JsonObject | None = None,
) -> JsonObject | None:
    if not scenario_supports_multi_tier_policy_comparison(scenario):
        return None
    rows = [multi_tier_activation_variant_row(result) for result in results]
    usable_rows = [row for row in rows if (int_or_none(row.get("sampleCount")) or 0) > 0]
    audit_ticks = int_or_none(audit.get("ticks")) if isinstance(audit, dict) else None
    horizon_too_short = audit_ticks is not None and audit_ticks < POLICY_GRADIENT_MIN_SIMULATION_TICKS
    passed_rows = [] if horizon_too_short else [row for row in usable_rows if row["passesActivation"]]
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
            "minimumSimulationTicks": POLICY_GRADIENT_MIN_SIMULATION_TICKS,
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
    if audit is not None:
        proof["audit"] = copy.deepcopy(audit)
    if passed_rows:
        proof["passingVariants"] = [row["variantId"] for row in passed_rows]
    else:
        if horizon_too_short:
            classification = "SIMULATION_HORIZON_TOO_SHORT"
            evidence = (
                f"multi-tier activation proof requires at least {POLICY_GRADIENT_MIN_SIMULATION_TICKS} ticks "
                f"per simulator environment; observed {audit_ticks}"
            )
        elif not usable_rows:
            classification = "SIMULATOR_NO_SUCCESSFUL_SAMPLES"
            evidence = "no successful simulator samples were available for multi-tier activation proof"
        elif transport_observed:
            classification = "SIMULATOR_OBJECTIVE_SIGNAL_NOT_ACTIVATED"
            evidence = (
                "multi-tier fixture signal reached variant metrics, but no single successful sample exceeded "
                f"territory score {MULTI_TIER_TERRITORY_ACTIVATION_THRESHOLD} or hostile kills "
                f"{MULTI_TIER_HOSTILE_KILLS_ACTIVATION_THRESHOLD}"
            )
        else:
            classification = "SIMULATOR_FIXTURE_SIGNAL_NOT_TRANSPORTED"
            evidence = "multi-tier card fixture evidence did not reach variant objective metrics"
        proof["blocker"] = {
            "classification": classification,
            "criticality": "P0",
            "evidence": evidence,
            "action": multi_tier_activation_blocker_action(classification),
        }
    return proof


def multi_tier_activation_blocker_action(classification: str) -> str:
    if classification == "SIMULATION_HORIZON_TOO_SHORT":
        return "rerun policy-gradient multi-tier validation with an extended simulation horizon"
    if classification == "SIMULATOR_NO_SUCCESSFUL_SAMPLES":
        return (
            "repair local/private simulator reliability so multi-tier activation proof has "
            "successful samples before paid Tencent validation"
        )
    if classification == "SIMULATOR_OBJECTIVE_SIGNAL_NOT_ACTIVATED":
        return (
            "repair simulator/bot objective actuation so at least one successful local/private sample "
            f"exceeds territory score {MULTI_TIER_TERRITORY_ACTIVATION_THRESHOLD} or hostile kills "
            f"{MULTI_TIER_HOSTILE_KILLS_ACTIVATION_THRESHOLD} before paid Tencent validation"
        )
    return "repair multi-tier fixture signal transport before paid Tencent validation"


def multi_tier_activation_variant_row(result: JsonObject) -> JsonObject:
    raw_samples = result.get("multiTierActivationSamples")
    samples = [sample for sample in raw_samples if isinstance(sample, dict)] if isinstance(raw_samples, list) else []
    raw_traces = result.get("multiTierActivationTraces")
    traces = [trace for trace in raw_traces if isinstance(trace, dict)] if isinstance(raw_traces, list) else []
    metrics = result.get("metrics") if isinstance(result.get("metrics"), dict) else {}
    aggregate_evidence = multi_tier_activation_metric_evidence(metrics) if metrics else empty_multi_tier_activation_evidence()
    sample_count = int_or_none(result.get("sampleCount")) or 0
    evidence_samples = samples or ([aggregate_evidence] if sample_count > 0 and metrics else [])
    territory_score = aggregate_evidence["territoryScore"]
    hostile_kills = aggregate_evidence["hostileKills"]
    observed = any(sample.get("objectiveSignalObserved") is True for sample in evidence_samples)
    passes = any(sample.get("passesActivation") is True for sample in evidence_samples)
    objective = metrics.get("objectiveSignal") if isinstance(metrics.get("objectiveSignal"), dict) else {}
    return {
        "variantId": result.get("variantId"),
        "sampleCount": result.get("sampleCount", 0),
        "territoryScore": round_float(territory_score),
        "hostileKills": round_float(hostile_kills),
        "objectiveSignalObserved": observed,
        "passesActivation": passes,
        "activationSampleCount": len(evidence_samples),
        "activationSamples": copy.deepcopy(evidence_samples),
        "activationTraces": copy.deepcopy(traces),
        "objectiveSignal": copy.deepcopy(objective),
    }


def multi_tier_activation_metric_evidence(metrics: JsonObject, *, sample_index: int | None = None) -> JsonObject:
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
    evidence: JsonObject = {
        "territoryScore": round_float(territory_score),
        "hostileKills": round_float(hostile_kills),
        "objectiveSignalObserved": observed,
        "activationScorePasses": activation_score_passes,
        "passesActivation": observed and activation_score_passes,
    }
    if sample_index is not None:
        evidence["sampleIndex"] = sample_index
    return evidence


def empty_multi_tier_activation_evidence() -> JsonObject:
    return {
        "territoryScore": 0,
        "hostileKills": 0,
        "objectiveSignalObserved": False,
        "activationScorePasses": False,
        "passesActivation": False,
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


def summarize_card(
    card: JsonObject,
    path: Path,
    *,
    runtime_parameter_injection: JsonObject | None = None,
) -> JsonObject:
    summary = {
        "path": dataset_export.display_path(path),
        "cardId": card.get("card_id", card.get("cardId")),
        "datasetRunId": card.get("dataset_run_id", card.get("datasetRunId")),
        "codeCommit": card.get("code_commit", card.get("codeCommit")),
        "trainingApproach": card.get("training_approach", card.get("trainingApproach")),
        "status": card.get("status", "shadow"),
        "policyFamily": card.get("policyFamily", card.get("policy_family")),
        "safety": card.get("safety"),
    }
    contract = first_present(card, ("role_policy_lanes", "rolePolicyLanes", "policyLaneContract"))
    if isinstance(contract, dict):
        summary["rolePolicyLanes"] = copy.deepcopy(contract)
    policy_gradient = policy_gradient_metadata_from_card(
        card,
        runtime_parameter_injection=runtime_parameter_injection,
    )
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


def raw_policy_gradient_metadata_from_card(card: JsonObject) -> JsonObject | None:
    raw = card.get("policy_gradient", card.get("policyGradient"))
    if not isinstance(raw, dict):
        return None
    return copy.deepcopy(raw)


def policy_gradient_metadata_from_card(
    card: JsonObject,
    *,
    runtime_parameter_injection: JsonObject | None = None,
) -> JsonObject | None:
    raw = raw_policy_gradient_metadata_from_card(card)
    if raw is None:
        return None
    reward_model = card.get("reward_model", card.get("rewardModel"))
    if isinstance(reward_model, dict):
        raw["rewardModel"] = copy.deepcopy(reward_model)
    return policy_gradient_metadata_with_runner_transport(
        raw,
        runtime_parameter_injection=runtime_parameter_injection,
    )


def policy_gradient_metadata_with_runner_transport(
    policy_gradient: JsonObject,
    *,
    runtime_parameter_injection: JsonObject | None = None,
) -> JsonObject:
    support = first_mapping(policy_gradient, ("runner_support", "runnerSupport"))
    if support is None:
        return policy_gradient
    declared_inline_applied = first_present(
        support,
        ("inline_candidates_applied_to_simulator", "inlineCandidatesAppliedToSimulator"),
    )
    if declared_inline_applied is not None:
        support["declaredInlineCandidatesAppliedToSimulator"] = declared_inline_applied
    if runtime_parameter_injection is None:
        return policy_gradient

    injected = runtime_parameter_injection.get("runtimeParameterInjection") is True
    consumed = runtime_parameter_injection.get("runtimeParameterConsumption") is True
    policy_update_reward_ready = injected and consumed
    status = text_or_none(runtime_parameter_injection.get("status"))
    scope = text_or_none(runtime_parameter_injection.get("candidateParameterScope")) or "metadata_only"
    attempted_runtime_injection = scope in {"runtime_injected", "partial_runtime_injection"} or status in {
        "partial",
        "not_injected",
    }
    support["inline_candidates_applied_to_simulator"] = injected
    support["inline_candidates_runtime_injected"] = injected
    support["runtime_parameter_injection"] = injected
    support["simulator_variant_transport"] = (
        "variant_ids_with_runtime_injected_parameters"
        if injected or attempted_runtime_injection
        else "variant_ids_with_inline_metadata"
    )
    support["candidate_parameter_scope"] = "runtime_injected" if injected else scope
    support["runtime_parameter_injection_status"] = status
    support["runtime_parameter_injection_reason"] = runtime_parameter_injection.get("reason")
    support["runtime_parameter_consumption_status"] = runtime_parameter_injection.get("runtimeParameterConsumptionStatus")
    support["runtime_parameter_consumption"] = consumed
    support["runtime_parameter_injected_variant_count"] = runtime_injected_variant_count(runtime_parameter_injection)
    support["runtime_parameter_consumed_variant_count"] = runtime_consumed_variant_count(runtime_parameter_injection)
    support["runtime_parameter_injection_mechanism"] = runtime_parameter_injection.get("mechanism")
    runtime_metadata_fallback = policy_gradient_allows_runtime_metadata_policy_update(policy_gradient)
    support["policy_update_reward_use"] = (
        "eligible_with_evaluated_runtime_parameters"
        if policy_update_reward_ready
        else "runtime_injected_metadata_scorecard_ranking"
        if runtime_metadata_fallback
        else "blocked_until_runtime_parameter_evidence"
    )
    if injected:
        support["limitation"] = (
            "Inline policy-gradient parameter vectors were materialized into private-simulator code uploads only; "
            "the report remains live-effect false and official-MMO-write false."
        )
    else:
        support["limitation"] = (
            "Inline policy-gradient parameter vectors did not reach every simulator runtime input; "
            "policy-update rewards stay blocked until evaluated runtime parameter evidence is complete."
        )
    return policy_gradient


def policy_gradient_candidate_parameters_metadata_only(policy_gradient: JsonObject) -> bool:
    support = first_mapping(policy_gradient, ("runner_support", "runnerSupport"))
    if support is None:
        return False
    runtime_injection = first_present(
        support,
        (
            "runtime_parameter_injection",
            "runtimeParameterInjection",
            "inline_candidates_runtime_injected",
            "inlineCandidatesRuntimeInjected",
        ),
    )
    inline_applied = first_present(
        support,
        ("inline_candidates_applied_to_simulator", "inlineCandidatesAppliedToSimulator"),
    )
    scope = text_or_none(first_present(support, ("candidate_parameter_scope", "candidateParameterScope")))
    transport = text_or_none(first_present(support, ("simulator_variant_transport", "simulatorVariantTransport")))
    status = text_or_none(
        first_present(support, ("runtime_parameter_injection_status", "runtimeParameterInjectionStatus"))
    )
    if status == "partial" or scope == "partial_runtime_injection":
        return False
    if scope == "runtime_injected":
        return False
    if (
        runtime_injection is True
        and inline_applied is True
        and scope == "runtime_injected"
        and transport == "variant_ids_with_runtime_injected_parameters"
    ):
        return False
    if scope == "metadata_only":
        return True
    if transport == "variant_ids_with_inline_metadata":
        return True
    if runtime_injection is False:
        return True
    return inline_applied is False


def policy_gradient_requires_runtime_parameter_evidence(policy_gradient: JsonObject) -> bool:
    support = first_mapping(policy_gradient, ("runner_support", "runnerSupport"))
    if support is None:
        return False
    scope = text_or_none(first_present(support, ("candidate_parameter_scope", "candidateParameterScope")))
    reward_use = text_or_none(first_present(support, ("policy_update_reward_use", "policyUpdateRewardUse")))
    status = text_or_none(
        first_present(support, ("runtime_parameter_injection_status", "runtimeParameterInjectionStatus"))
    )
    runtime_injection = first_present(
        support,
        (
            "runtime_parameter_injection",
            "runtimeParameterInjection",
            "inline_candidates_runtime_injected",
            "inlineCandidatesRuntimeInjected",
        ),
    )
    return (
        runtime_injection is True
        or scope == "runtime_injected"
        or scope == "partial_runtime_injection"
        or status == "partial"
        or status == "not_injected"
        or reward_use == "eligible_with_evaluated_runtime_parameters"
    )


def policy_gradient_allows_runtime_metadata_policy_update(policy_gradient: JsonObject) -> bool:
    support = first_mapping(policy_gradient, ("runner_support", "runnerSupport"))
    if support is None:
        return False
    scope = text_or_none(first_present(support, ("candidate_parameter_scope", "candidateParameterScope")))
    transport = text_or_none(first_present(support, ("simulator_variant_transport", "simulatorVariantTransport")))
    status = text_or_none(
        first_present(support, ("runtime_parameter_injection_status", "runtimeParameterInjectionStatus"))
    )
    consumption_status = text_or_none(
        first_present(support, ("runtime_parameter_consumption_status", "runtimeParameterConsumptionStatus"))
    )
    declared_inline_applied = first_present(
        support,
        ("declaredInlineCandidatesAppliedToSimulator", "declared_inline_candidates_applied_to_simulator"),
    )
    preserves_parameters = first_present(
        support,
        ("report_preserves_candidate_parameters", "reportPreservesCandidateParameters"),
    )
    preserves_candidate_policy_id = first_present(
        support,
        ("candidate_policy_id_preserved", "candidatePolicyIdPreserved"),
    )
    return (
        scope == "runtime_injected"
        and transport == "variant_ids_with_runtime_injected_parameters"
        and status in {"injected", "not_injected"}
        and runtime_parameter_consumption_blocker_status(consumption_status)
        and declared_inline_applied is True
        and preserves_parameters is True
        and preserves_candidate_policy_id is True
    )


def policy_gradient_candidate_vector_count(policy_gradient: JsonObject) -> int:
    candidates = first_present(policy_gradient, ("candidate_parameter_vectors", "candidateParameterVectors"))
    if not isinstance(candidates, list):
        return 0
    return sum(1 for candidate in candidates if isinstance(candidate, dict))


def policy_update_metadata_only_parameter_evidence() -> JsonObject:
    return {
        "candidateParameterScope": "metadata_only",
        "runtimeParameterInjection": False,
        "runtimeParameterConsumption": False,
        "policyUpdateEligible": False,
        "reason": (
            "candidate rewards were produced by the shared uploaded bot artifact; inline parameter vectors "
            "were not injected into simulator runtime behavior"
        ),
    }


def policy_update_promotion_gate(
    parameter_evidence: JsonObject,
    *,
    policy_update_generated: bool,
    gradient_stability: JsonObject | None = None,
) -> JsonObject:
    """Classify whether a policy update has runtime consumption and trusted gradient proof."""
    runtime_injection = parameter_evidence.get("runtimeParameterInjection") is True
    runtime_consumed = parameter_evidence.get("runtimeParameterConsumption") is True
    eligibility_mode = text_or_none(parameter_evidence.get("eligibilityMode"))
    scope = text_or_none(parameter_evidence.get("candidateParameterScope")) or "metadata_only"
    consumption_status = text_or_none(parameter_evidence.get("runtimeParameterConsumptionStatus"))
    gradient_gate_present = isinstance(gradient_stability, dict)
    trusted_gradient_update = (
        gradient_stability.get("trustedUpdate") is True if gradient_gate_present else True
    )
    gradient_high_variance = gradient_stability.get("highVariance") is True if gradient_gate_present else False
    gradient_classification = (
        text_or_none(gradient_stability.get("classification")) if gradient_gate_present else None
    )
    gradient_reason = text_or_none(gradient_stability.get("reason")) if gradient_gate_present else None

    if runtime_consumed and not trusted_gradient_update:
        consumption_mode = POLICY_UPDATE_CONSUMPTION_MODE_RUNTIME_CONSUMED
        status = "blocked_gradient_stability_untrusted"
        missing_prerequisites = ["gradient_stability"]
        if gradient_classification == "gradient_estimation_scheme_mismatch_non_comparable":
            missing_prerequisites.append("gradient_estimation_scheme")
        reason = (
            "tick-time runtime policy parameter consumption proof is present, but the true-gradient "
            "estimate is not trusted because gradient-estimation scheme comparability, sample size, "
            "or per-sample direction consistency failed"
        )
    elif runtime_consumed:
        consumption_mode = POLICY_UPDATE_CONSUMPTION_MODE_RUNTIME_CONSUMED
        status = "runtime_consumed_shadow_candidate"
        missing_prerequisites: list[str] = []
        reason = (
            "tick-time runtime policy parameter consumption proof is present; candidate remains "
            "offline/shadow and still requires normal scorecard and rollout gates before any live effect"
        )
    elif eligibility_mode == "runtime_injected_metadata_scorecard_ranking":
        consumption_mode = POLICY_UPDATE_CONSUMPTION_MODE_SCORECARD_NON_CONSUMED
        status = "blocked_runtime_parameter_consumption_missing"
        missing_prerequisites = ["runtime_parameter_consumption"]
        reason = (
            "#924-compatible scorecard metadata produced an offline true-gradient candidate, but "
            "#907 change-control semantics block Loop A/Loop B promotion until tick-time runtime "
            "policy parameter consumption evidence is present"
        )
    elif scope == "metadata_only":
        consumption_mode = POLICY_UPDATE_CONSUMPTION_MODE_METADATA_ONLY
        status = "blocked_runtime_parameter_injection_missing"
        missing_prerequisites = ["runtime_parameter_injection", "runtime_parameter_consumption"]
        reason = (
            "candidate parameters were metadata-only and cannot be promoted or classified as "
            "runtime-consumed without runtime injection and consumption evidence"
        )
    else:
        consumption_mode = POLICY_UPDATE_CONSUMPTION_MODE_INCOMPLETE
        status = "blocked_runtime_parameter_consumption_missing"
        missing_prerequisites = ["runtime_parameter_consumption"]
        reason = (
            "runtime parameter evidence is incomplete; Loop A/Loop B must not classify the update "
            "as runtime-consumed or promotional"
        )

    runtime_consumed_promotion_eligible = policy_update_generated and runtime_consumed and trusted_gradient_update
    scalar_authorized = parameter_evidence.get("scalarWeightedSumAuthorized") is True
    if scalar_authorized and runtime_consumed_promotion_eligible:
        status = "blocked_loop_b_advantage_gate_pending"
        missing_prerequisites = ["loop_b_policy_advantage_gate"]
        reason = (
            "scalar weighted reward is authorized only for offline/private/shadow comparison; "
            "Loop A/Loop B promotion remains blocked until the Loop B advantage gate passes"
        )
        runtime_consumed_promotion_eligible = False
    payload: JsonObject = {
        "type": POLICY_UPDATE_PROMOTION_GATE_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "status": status,
        "consumptionMode": consumption_mode,
        "policyUpdateGenerated": policy_update_generated,
        "runtimeParameterInjection": runtime_injection,
        "runtimeParameterConsumption": runtime_consumed,
        "runtimeParameterConsumptionStatus": consumption_status or ("consumed" if runtime_consumed else "missing"),
        "candidateParameterScope": scope,
        "runtimeConsumedPromotionEligible": runtime_consumed_promotion_eligible,
        "loopAPromotionEligible": runtime_consumed_promotion_eligible,
        "loopBPromotionEligible": runtime_consumed_promotion_eligible,
        "missingPrerequisites": missing_prerequisites,
        "reason": reason,
        "validationText": (
            "#924 scorecards and #907 change-control require tick-time runtime parameter "
            "consumption proof plus trusted gradient stability before Loop A or Loop B can "
            "treat a policy update as runtime-consumed or promotional."
        ),
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }
    if scalar_authorized:
        payload["scalarWeightedSumAuthorized"] = True
        payload["scalarWeightedSumUse"] = parameter_evidence.get("scalarWeightedSumUse")
        payload["loopBAdvantageGate"] = parameter_evidence.get("loopBAdvantageGate") or "required_before_promotion"
    if gradient_gate_present:
        payload["gradientStable"] = gradient_stability.get("gradientStable") is True
        payload["trustedGradientUpdate"] = trusted_gradient_update
        payload["highVariance"] = gradient_high_variance
        payload["gradientClassification"] = gradient_classification
        if gradient_reason is not None:
            payload["gradientTrustGateReason"] = gradient_reason
            if gradient_high_variance:
                payload["highVarianceReason"] = gradient_reason
        payload["gradientSchemeComparable"] = gradient_stability.get("gradientSchemeComparable") is not False
        payload["gradientSchemeComparisonStatus"] = text_or_none(
            gradient_stability.get("gradientSchemeComparisonStatus")
        )
        payload["gradientSchemeKey"] = text_or_none(gradient_stability.get("gradientSchemeKey"))
        payload["gradientComparisonKey"] = text_or_none(gradient_stability.get("gradientComparisonKey"))
        payload["gradientStability"] = copy.deepcopy(gradient_stability)
    return payload


def policy_update_runtime_injection_incomplete_parameter_evidence(policy_gradient: JsonObject) -> JsonObject:
    support = first_mapping(policy_gradient, ("runner_support", "runnerSupport")) or {}
    return {
        "candidateParameterScope": first_present(support, ("candidate_parameter_scope", "candidateParameterScope"))
        or "runtime_injected",
        "runtimeParameterInjection": False,
        "runtimeParameterTransport": first_present(
            support,
            (
                "runtime_parameter_injection",
                "runtimeParameterInjection",
                "inline_candidates_runtime_injected",
                "inlineCandidatesRuntimeInjected",
            ),
        )
        is True,
        "runtimeParameterConsumption": False,
        "policyUpdateEligible": False,
        "reason": (
            "policy-gradient rewards were not backed by complete evaluated runtime parameter evidence "
            "for every candidate variant"
        ),
    }


def policy_update_runtime_injection_ready_parameter_evidence(
    policy_gradient: JsonObject,
    candidates: Sequence[JsonObject],
) -> JsonObject:
    support = first_mapping(policy_gradient, ("runner_support", "runnerSupport")) or {}
    scope = (
        first_present(support, ("candidate_parameter_scope", "candidateParameterScope"))
        or "runtime_injected"
    )
    runtime_injection = first_present(
        support,
        (
            "runtime_parameter_injection",
            "runtimeParameterInjection",
            "inline_candidates_runtime_injected",
            "inlineCandidatesRuntimeInjected",
        ),
    ) is True
    consumption_status = text_or_none(
        first_present(support, ("runtime_parameter_consumption_status", "runtimeParameterConsumptionStatus"))
    )
    runtime_consumption = (
        consumption_status == "consumed"
        or first_present(support, ("runtime_parameter_consumption", "runtimeParameterConsumption")) is True
    )
    runtime_metadata_fallback = policy_gradient_allows_runtime_metadata_policy_update(policy_gradient)
    scalar_authorized = policy_gradient_scalar_weighted_sum_authorized(policy_gradient)
    candidate_count_ready = len(candidates) >= policy_gradient_candidate_vector_count(policy_gradient)
    eligible = (
        scope == "runtime_injected"
        and policy_gradient_requires_runtime_parameter_evidence(policy_gradient)
        and candidate_count_ready
        and ((runtime_injection and runtime_consumption) or runtime_metadata_fallback)
    )
    payload: JsonObject = {
        "candidateParameterScope": scope,
        "runtimeParameterInjection": runtime_injection,
        "runtimeParameterConsumption": runtime_consumption,
        "policyUpdateEligible": eligible,
        "candidateCount": len(candidates),
        "metadataCandidateCount": policy_gradient_candidate_vector_count(policy_gradient),
        "eligibilityMode": (
            "evaluated_runtime_parameter_evidence"
            if runtime_injection and runtime_consumption
            else "runtime_injected_metadata_scorecard_ranking"
            if runtime_metadata_fallback
            else "blocked_until_runtime_parameter_consumption_evidence"
            if runtime_injection
            else "blocked_until_runtime_parameter_evidence"
        ),
    }
    if scalar_authorized:
        payload["scalarWeightedSumAuthorized"] = True
        payload["scalarWeightedSumUse"] = scalar_weighted_sum_use(
            first_mapping(policy_gradient, ("reward_model", "rewardModel"))
        )
        payload["loopBAdvantageGate"] = "required_before_promotion"
    if consumption_status is not None:
        payload["runtimeParameterConsumptionStatus"] = consumption_status
    if eligible:
        if runtime_metadata_fallback and not runtime_consumption:
            payload["reason"] = (
                "runtime-injected simulator transport and preserved candidate parameter metadata produced "
                "a scorecarded offline ranking, but the private simulator did not expose consumption-probe "
                "evidence; the bounded update remains offline/shadow only"
            )
        else:
            payload["reason"] = (
                "scored candidate rewards were backed by complete evaluated runtime parameter evidence"
            )
    else:
        payload["reason"] = (
            "policy updates require runtime-injected candidate parameter transport and complete "
            "evaluated runtime parameter evidence"
        )
    return payload


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


def rollback_policy_gradient_momentum_state_artifact(
    path: Path,
    previous_bytes: bytes | None,
    *,
    previous_artifact_existed: bool = False,
) -> None:
    if previous_bytes is None:
        if previous_artifact_existed:
            return
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    temp_fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".rollback.tmp", dir=str(path.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(temp_fd, "wb") as handle:
            temp_fd = -1
            handle.write(previous_bytes)
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
    activation_proof = report.get("activationProof")
    summary_ok = not (
        isinstance(activation_proof, dict)
        and (activation_proof.get("ok") is False or isinstance(activation_proof.get("blocker"), dict))
    )
    summary = {
        "ok": summary_ok,
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
        "batchScale": copy.deepcopy(report.get("batchScale")),
        "changedTopCount": report["changedTopCount"],
        "policyUpdateIterations": report.get("policyUpdateIterations", 0),
        "policyUpdateAlgorithm": report.get("policyUpdateAlgorithm"),
        "policyUpdateCandidatePolicyId": report.get("policyUpdateCandidatePolicyId"),
        "policyUpdateArtifactPath": report.get("policyUpdateArtifactPath"),
        "policyUpdatePromotionGate": copy.deepcopy(report.get("policyUpdatePromotionGate")),
        "trueGradient": report.get("trueGradient", False),
        "gradientStable": report.get("gradientStable", False),
        "trustedGradientUpdate": report.get("trustedGradientUpdate", False),
        "highVariance": report.get("highVariance", False),
        "gradientTrustGateClassification": report.get("gradientTrustGateClassification"),
        "gradientTrustGateReason": report.get("gradientTrustGateReason"),
        "highVarianceReason": report.get("highVarianceReason"),
        "gradientEstimation": copy.deepcopy(report.get("gradientEstimation")),
        "gradientMomentum": copy.deepcopy(report.get("gradientMomentum")),
        "gradientMomentumState": copy.deepcopy(report.get("gradientMomentumState")),
        "gradientStability": copy.deepcopy(report.get("gradientStability")),
        "runtimeParameterInjection": copy.deepcopy(report.get("runtimeParameterInjection")),
        "scorecardId": report.get("scorecardId"),
        "scorecardArtifactPath": report.get("scorecardArtifactPath"),
        "candidateScorecard": copy.deepcopy(report.get("candidateScorecard")),
        "candidateScorecards": copy.deepcopy(report.get("candidateScorecards")),
        "rolePolicies": copy.deepcopy(report.get("rolePolicies", [])),
        "trainingRoles": copy.deepcopy(report.get("trainingRoles", [])),
        "rolePolicyMetadata": copy.deepcopy(report.get("rolePolicyMetadata")),
        "scalarWeightedReward": copy.deepcopy(report.get("scalarWeightedReward")),
        "conclusionRegistryUpdate": copy.deepcopy(report.get("conclusionRegistryUpdate")),
        "warnings": report["warnings"],
    }
    if "scaleValidation" in report:
        summary["scaleValidation"] = report["scaleValidation"]
    if isinstance(activation_proof, dict):
        proof = activation_proof
        summary["activationProof"] = {
            "status": proof.get("status"),
            "ok": proof.get("ok"),
            "blocker": copy.deepcopy(proof.get("blocker")) if isinstance(proof.get("blocker"), dict) else None,
            "passingVariants": copy.deepcopy(proof.get("passingVariants", [])),
            "bestObserved": copy.deepcopy(proof.get("bestObserved", {})),
        }
        if isinstance(proof.get("audit"), dict):
            summary["activationProof"]["audit"] = copy.deepcopy(proof["audit"])
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
