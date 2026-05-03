#!/usr/bin/env python3
"""Run offline Screeps RL strategy experiments against the private simulator harness."""

from __future__ import annotations

import argparse
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

import screeps_rl_dataset_export as dataset_export
import screeps_rl_simulator_harness as simulator_harness


SCHEMA_VERSION = 1
REPORT_TYPE = "screeps-rl-training-report"
SUMMARY_TYPE = "screeps-rl-training-generation"
DEFAULT_OUT_DIR = Path("runtime-artifacts/rl-training")
DEFAULT_RESOURCE_NORMALIZER = 1000.0
DEFAULT_RUN_REPETITIONS = 1
REWARD_TIERS = ("territory", "resources", "kills")
REPORT_ID_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
STRATEGY_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]+$")
JsonObject = dict[str, Any]
SimulatorRunner = Callable[..., JsonObject]


class TrainingCardError(ValueError):
    """Raised when an experiment card is unsafe or structurally invalid."""


@dataclass(frozen=True)
class StrategyVariant:
    """Strategy candidate metadata consumed by the simulator and report."""

    id: str
    parameters: JsonObject
    family: str | None = None
    rollout_status: str | None = None
    source: str = "inline"
    title: str | None = None

    def to_json(self) -> JsonObject:
        payload: JsonObject = {
            "id": self.id,
            "parameters": self.parameters,
            "source": self.source,
        }
        if self.family:
            payload["family"] = self.family
        if self.rollout_status:
            payload["rolloutStatus"] = self.rollout_status
        if self.title:
            payload["title"] = self.title
        return payload


@dataclass(frozen=True)
class SimulationConfig:
    """Private simulator run settings shared across all variants."""

    ticks: int
    workers: int
    repetitions: int
    room: str
    shard: str
    branch: str
    code_path: Path
    map_source_file: Path
    simulator_out_dir: Path

    def to_json(self) -> JsonObject:
        return {
            "ticks": self.ticks,
            "workers": self.workers,
            "repetitions": self.repetitions,
            "room": self.room,
            "shard": self.shard,
            "branch": self.branch,
            "codePath": str(self.code_path),
            "mapSourceFile": str(self.map_source_file),
            "simulatorOutDir": str(self.simulator_out_dir),
        }


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    ).hexdigest()


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
    status = card.get("status", "shadow")
    if status != "shadow":
        raise TrainingCardError("status must be shadow")

    safety = card.get("safety")
    if not isinstance(safety, dict):
        raise TrainingCardError("safety must be present and must be an object")
    for field in ("liveEffect", "officialMmoWrites", "officialMmoWritesAllowed"):
        if safety.get(field) is not False:
            raise TrainingCardError(f"safety.{field} must be false")
        if field in card and card[field] is not False:
            raise TrainingCardError(f"{field} must be false when present")

    reward_model = card.get("reward_model", card.get("rewardModel"))
    if not isinstance(reward_model, dict):
        raise TrainingCardError("reward_model must be present and must be an object")
    order = reward_model.get("component_order", reward_model.get("componentOrder"))
    if order not in (list(REWARD_TIERS), ["reliability", *REWARD_TIERS]):
        raise TrainingCardError("reward_model.component_order must preserve territory, resources, kills")
    if reward_model.get("scalar_weighted_sum_authorized", reward_model.get("scalarWeightedSumAuthorized", False)) is True:
        raise TrainingCardError("reward_model.scalar_weighted_sum_authorized must be false")

    raw_variants = raw_variant_definitions(card)
    if not isinstance(raw_variants, list) or len(raw_variants) == 0:
        raise TrainingCardError("experiment card must define at least one strategy variant")

    simulation = raw_mapping(card.get("simulation", card.get("simulator", {})), "simulation")
    if "ticks" in simulation and positive_int_value(simulation["ticks"]) is None:
        raise TrainingCardError("simulation.ticks must be a positive integer")
    if "workers" in simulation and positive_int_value(simulation["workers"]) is None:
        raise TrainingCardError("simulation.workers must be a positive integer")
    if "repetitions" in simulation and positive_int_value(simulation["repetitions"]) is None:
        raise TrainingCardError("simulation.repetitions must be a positive integer")


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
    family = text_or_none(raw.get("family")) or (registry_variant.family if registry_variant else None)
    rollout_status = (
        text_or_none(raw.get("rolloutStatus"))
        or text_or_none(raw.get("rollout_status"))
        or (registry_variant.rollout_status if registry_variant else None)
    )
    title = text_or_none(raw.get("title")) or (registry_variant.title if registry_variant else None)
    return StrategyVariant(
        id=variant_id,
        parameters=dict(sorted(parameters.items())),
        family=family,
        rollout_status=rollout_status,
        source=source,
        title=title,
    )


def load_strategy_registry(path: Path) -> dict[str, StrategyVariant]:
    """Parse the existing TypeScript registry enough to recover ids and default parameter sets."""
    if not path.exists():
        return {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}

    text = re.sub(r"//.*", "", text)
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
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
        if char in ("'", '"'):
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
    )


def positive_int_value(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value > 0:
        return value
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
    stdout: TextIO | None = None,
) -> JsonObject:
    """Run all card variants through the simulator harness and write a JSON report."""
    card = load_experiment_card(card_path)
    variants = load_strategy_variants(card, registry_path=registry_path)
    config = simulation_config_from_card(card)
    reward_options = reward_options_from_card(card)
    resolved_report_id = report_id or default_report_id(card, variants, config)
    validate_report_id(resolved_report_id)

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
    assert_no_secret_leak(report, dataset_export.configured_secret_values())
    report_path = out_dir.expanduser() / f"{resolved_report_id}.json"
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
    for repetition in range(config.repetitions):
        run_id = base_run_id if config.repetitions == 1 else f"{base_run_id}-r{repetition + 1:02d}"
        runs.append(
            simulator_runner(
                ticks=config.ticks,
                workers=config.workers,
                variants=variant_ids,
                out_dir=config.simulator_out_dir,
                run_id=run_id,
                room=config.room,
                shard=config.shard,
                branch=config.branch,
                code_path=config.code_path,
                map_source_file=config.map_source_file,
            )
        )
    return runs


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
    for field in ("officialMmoWrites", "official_mmo_writes"):
        if payload.get(field) is True:
            unsafe.append(f"{label}.{field}=true")
    return unsafe


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
    per_variant_runs = collect_variant_runs(simulator_runs)
    results = [
        summarize_variant(variant, per_variant_runs.get(variant.id, []), reward_options)
        for variant in variants
    ]
    scored_results = [result for result in results if result["sampleCount"] > 0]
    ranking = rank_variant_results(scored_results)
    incumbent_ids = incumbent_strategy_ids(variants)
    model_reports = build_shadow_compatible_model_reports(ranking, incumbent_ids)
    pairwise = build_pairwise_comparisons(scored_results)
    changed_top_count = 1 if ranking and incumbent_ids and ranking[0]["variantId"] not in incumbent_ids else 0
    ranking_diff_count = sum(1 for item in pairwise if item.get("winner") and item["winner"] not in incumbent_ids)
    warnings = build_report_warnings(results, simulator_runs)

    return {
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
                "compare (roomsGained - roomsLost, "
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
        "modelFamilies": sorted({text for text in (result.get("family") for result in results) if isinstance(text, str)}),
        "modelReports": model_reports,
        "kpiSummary": build_kpi_summary(scored_results),
        "warnings": warnings,
    }


def collect_variant_runs(simulator_runs: Sequence[JsonObject]) -> dict[str, list[JsonObject]]:
    collected: dict[str, list[JsonObject]] = {}
    for run in simulator_runs:
        if not isinstance(run, dict):
            continue
        raw_variants = run.get("variants")
        if not isinstance(raw_variants, list):
            continue
        for raw_variant in raw_variants:
            if not isinstance(raw_variant, dict):
                continue
            variant_id = raw_variant.get("variant_id", raw_variant.get("variantId"))
            if isinstance(variant_id, str):
                collected.setdefault(variant_id, []).append(raw_variant)
    return collected


def summarize_variant(
    variant: StrategyVariant,
    runs: Sequence[JsonObject],
    reward_options: JsonObject,
) -> JsonObject:
    scored_runs = [run for run in runs if run.get("ok") is True]
    excluded_run_count = len(runs) - len(scored_runs)
    run_metrics = [compute_run_metrics(run, reward_options) for run in scored_runs]
    reward_tuple = mean_reward_tuple(run_metrics)
    return {
        "variantId": variant.id,
        "family": variant.family,
        "rolloutStatus": variant.rollout_status,
        "sampleCount": len(run_metrics),
        "excludedRunCount": excluded_run_count,
        "ok": bool(scored_runs) and excluded_run_count == 0,
        "parameters": variant.parameters,
        "reward": {
            "type": "lexicographic",
            "componentOrder": list(REWARD_TIERS),
            "tuple": reward_tuple,
            "samples": [metrics["rewardTuple"] for metrics in run_metrics],
            "sampleStdDev": reward_stddev(run_metrics),
        },
        "metrics": aggregate_metrics(run_metrics),
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


def compute_run_metrics(run: JsonObject, reward_options: JsonObject) -> JsonObject:
    explicit_metrics = run.get("metrics") if isinstance(run.get("metrics"), dict) else {}
    tick_log = run.get("tick_log", run.get("tickLog"))
    ticks = tick_log if isinstance(tick_log, list) else []
    initial_rooms = normalize_room_map(explicit_metrics.get("initialRooms", explicit_metrics.get("initial_rooms")))
    final_rooms = normalize_room_map(explicit_metrics.get("finalRooms", explicit_metrics.get("final_rooms")))
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

    reward_tuple = [round_float(territory_delta), round_float(resources_delta), round_float(combat_delta)]
    return {
        "rewardTuple": reward_tuple,
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
    if summary.get("claimed") is True or summary.get("owned") is True or summary.get("my") is True:
        return True
    controller = summary.get("controller")
    if isinstance(controller, dict):
        if controller.get("my") is True or controller.get("owned") is True:
            return True
        owner = controller.get("owner")
        if isinstance(owner, str) and owner:
            return True
        if isinstance(owner, dict) and owner:
            return True
    if spawn_count(summary) > 0 and controller_level(summary) > 0:
        return True
    return False


def room_survived(summary: JsonObject) -> bool:
    return spawn_count(summary) > 0 and creep_count(summary) > 0


def spawn_count(summary: JsonObject) -> int:
    for key in ("owned_spawns", "ownedSpawnCount", "spawnCount", "spawns"):
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
    for key in ("owned_creeps", "ownedCreeps", "ownedCreepCount", "creeps", "workerCount"):
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
        return [0, 0, 0]
    columns = list(zip(*(metric["rewardTuple"] for metric in metrics)))
    return [round_float(statistics.fmean(float(value) for value in column)) for column in columns]


def reward_stddev(metrics: Sequence[JsonObject]) -> list[float | int]:
    if len(metrics) <= 1:
        return [0, 0, 0]
    columns = list(zip(*(metric["rewardTuple"] for metric in metrics)))
    return [round_float(statistics.pstdev(float(value) for value in column)) for column in columns]


def aggregate_metrics(metrics: Sequence[JsonObject]) -> JsonObject:
    if not metrics:
        return {
            "territory": empty_territory_metrics(),
            "resources": empty_resource_metrics(),
            "kills": empty_kill_metrics(),
        }
    return {
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
    }


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
        key=lambda item: (
            float(item["reward"]["tuple"][0]),
            float(item["reward"]["tuple"][1]),
            float(item["reward"]["tuple"][2]),
            item["variantId"],
        ),
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
                        "territory": round_float(float(left["reward"]["tuple"][0]) - float(right["reward"]["tuple"][0])),
                        "resources": round_float(float(left["reward"]["tuple"][1]) - float(right["reward"]["tuple"][1])),
                        "kills": round_float(float(left["reward"]["tuple"][2]) - float(right["reward"]["tuple"][2])),
                    },
                }
            )
    return comparisons


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
        if float(left[index]) != float(right[index]):
            return tier
    return None


def incumbent_strategy_ids(variants: Sequence[StrategyVariant]) -> list[str]:
    incumbents = [variant.id for variant in variants if variant.rollout_status == "incumbent"]
    return incumbents or ([variants[0].id] if variants else [])


def build_shadow_compatible_model_reports(ranking: Sequence[JsonObject], incumbent_ids: Sequence[str]) -> list[JsonObject]:
    incumbent = incumbent_ids[0] if incumbent_ids else None
    reports: list[JsonObject] = []
    rank_by_variant = {item["variantId"]: item["rank"] for item in ranking}
    incumbent_rank = rank_by_variant.get(incumbent) if incumbent else None
    for item in ranking:
        variant_id = item["variantId"]
        if variant_id == incumbent:
            continue
        changed_top = item["rank"] == 1 and variant_id != incumbent
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
    return {
        "territory": {
            "score": best["rewardTuple"][0],
            "components": {
                result["variantId"]: result["metrics"]["territory"]["delta"]
                for result in results
            },
        },
        "resources": {
            "score": best["rewardTuple"][1],
            "components": {
                result["variantId"]: result["metrics"]["resources"]["delta"]
                for result in results
            },
        },
        "kills": {
            "score": best["rewardTuple"][2],
            "components": {
                result["variantId"]: result["metrics"]["kills"]["delta"]
                for result in results
            },
        },
    }


def build_report_warnings(results: Sequence[JsonObject], simulator_runs: Sequence[JsonObject]) -> list[str]:
    warnings: list[str] = []
    for result in results:
        excluded_run_count = int(result.get("excludedRunCount", 0))
        if excluded_run_count > 0:
            warnings.append(
                f"variant {result['variantId']} excluded {excluded_run_count} failed simulator run(s) from reward scoring"
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
    return {
        "path": dataset_export.display_path(path),
        "cardId": card.get("card_id", card.get("cardId")),
        "datasetRunId": card.get("dataset_run_id", card.get("datasetRunId")),
        "codeCommit": card.get("code_commit", card.get("codeCommit")),
        "trainingApproach": card.get("training_approach", card.get("trainingApproach")),
        "status": card.get("status", "shadow"),
        "safety": card.get("safety"),
    }


def safety_metadata() -> JsonObject:
    return {
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
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
    return {
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
        "warnings": report["warnings"],
    }


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
        )
        stdout.write(canonical_json(report if args.print_report else build_generation_summary(report)))
        return 0
    except (RuntimeError, TrainingCardError, OSError) as error:
        stderr.write(f"error: {error}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
