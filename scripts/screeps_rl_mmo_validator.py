#!/usr/bin/env python3
"""Validate RL strategy candidates against historical official-MMO evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence, TextIO

import screeps_rl_dataset_export as dataset_export


SCHEMA_VERSION = 1
REPORT_TYPE = "screeps-rl-mmo-validation-report"
SUMMARY_TYPE = "screeps-rl-mmo-validation-generation"
DEFAULT_OUT_DIR = Path("runtime-artifacts/rl-mmo-validation")
DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024
DEFAULT_RESOURCE_NORMALIZER = 1000.0
DEFAULT_MIN_SCENARIOS = 1
METRIC_ORDER = ("reliability", "territory", "resources", "kills")
HIGHER_IS_BETTER = {metric: True for metric in METRIC_ORDER}
REPORT_ID_PREFIX = "rl-mmo-val"

JsonObject = dict[str, Any]


class ValidationConfigError(ValueError):
    """Raised when a candidate config is unsafe or structurally invalid."""


@dataclass(frozen=True)
class SourceMetadata:
    source_id: str
    path: str
    artifact_kind: str
    line_number: int | None = None

    def to_json(self) -> JsonObject:
        payload: JsonObject = {
            "sourceId": self.source_id,
            "path": self.path,
            "artifactKind": self.artifact_kind,
        }
        if self.line_number is not None:
            payload["lineNumber"] = self.line_number
        return payload


@dataclass(frozen=True)
class HistoricalScenario:
    scenario_id: str
    source: SourceMetadata
    baseline_metrics: JsonObject
    candidate_metrics: JsonObject | None
    tick_count: int
    room_names: tuple[str, ...]
    evidence_mode: str

    def to_json(self) -> JsonObject:
        return {
            "scenarioId": self.scenario_id,
            "source": self.source.to_json(),
            "tickCount": self.tick_count,
            "roomNames": list(self.room_names),
            "evidenceMode": self.evidence_mode,
            "baselineMetrics": self.baseline_metrics,
            **({"candidateMetrics": self.candidate_metrics} if self.candidate_metrics is not None else {}),
        }


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    ).hexdigest()


def load_candidate_config(path: Path) -> JsonObject:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValidationConfigError(f"{path} is not valid JSON: {error}") from error
    except OSError as error:
        raise ValidationConfigError(f"could not read candidate config {path}: {error}") from error
    if not isinstance(loaded, dict):
        raise ValidationConfigError("candidate config must be a JSON object")
    assert_shadow_safe_config(loaded)
    return loaded


def assert_shadow_safe_config(config: JsonObject) -> None:
    unsafe: list[str] = []
    for path, value in walk_json(config):
        key = path[-1] if path else ""
        if key in {
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
        } and value is True:
            unsafe.append(".".join(path))
    if unsafe:
        raise ValidationConfigError("candidate config is not shadow-safe: " + ", ".join(sorted(unsafe)))


def walk_json(value: Any, path: tuple[str, ...] = ()) -> Iterable[tuple[tuple[str, ...], Any]]:
    yield path, value
    if isinstance(value, dict):
        for key, nested in value.items():
            if isinstance(key, str):
                yield from walk_json(nested, (*path, key))
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            yield from walk_json(nested, (*path, str(index)))


def text_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def number_or_none(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    if isinstance(value, str):
        try:
            parsed = float(value)
        except ValueError:
            return None
        return parsed if math.isfinite(parsed) else None
    return None


def round_float(value: float | int | None) -> float | int | None:
    if value is None:
        return None
    if isinstance(value, int):
        return value
    if float(value).is_integer():
        return int(value)
    return round(float(value), 6)


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def candidate_strategy_id(config: JsonObject) -> str:
    for key in ("candidateStrategyId", "strategyId", "id"):
        value = text_or_none(config.get(key))
        if value:
            return dataset_export.redact_text(value)
    candidate = config.get("candidate")
    if isinstance(candidate, dict):
        for key in ("strategyId", "id", "candidateStrategyId"):
            value = text_or_none(candidate.get(key))
            if value:
                return dataset_export.redact_text(value)
    return "candidate"


def baseline_strategy_id(config: JsonObject) -> str:
    for key in ("incumbentStrategyId", "baselineStrategyId"):
        value = text_or_none(config.get(key))
        if value:
            return dataset_export.redact_text(value)
    baseline = config.get("baseline")
    if isinstance(baseline, dict):
        for key in ("strategyId", "id", "incumbentStrategyId", "baselineStrategyId"):
            value = text_or_none(baseline.get(key))
            if value:
                return dataset_export.redact_text(value)
    return "incumbent"


def metric_model(config: JsonObject, *, side: str) -> JsonObject:
    side_obj = config.get(side)
    model: JsonObject = {}
    if isinstance(side_obj, dict):
        for key in ("metricModel", "metric_model", "metricProjections", "metric_projections"):
            if isinstance(side_obj.get(key), dict):
                model.update(normalize_metric_model(side_obj[key]))

    key_prefix = "candidate" if side == "candidate" else "baseline"
    for key in (
        f"{key_prefix}MetricModel",
        f"{key_prefix}_metric_model",
        f"{key_prefix}MetricProjections",
        f"{key_prefix}_metric_projections",
    ):
        if isinstance(config.get(key), dict):
            model.update(normalize_metric_model(config[key]))

    if side == "candidate":
        for key in ("metricModel", "metric_model", "metricProjections", "metric_projections"):
            if isinstance(config.get(key), dict):
                model.update(normalize_metric_model(config[key]))
        if isinstance(config.get("metricDeltas"), dict):
            for metric, value in config["metricDeltas"].items():
                if metric in METRIC_ORDER and number_or_none(value) is not None:
                    model.setdefault(metric, {})["delta"] = number_or_none(value)
        if isinstance(config.get("metricMultipliers"), dict):
            for metric, value in config["metricMultipliers"].items():
                if metric in METRIC_ORDER and number_or_none(value) is not None:
                    model.setdefault(metric, {})["multiplier"] = number_or_none(value)

    return model


def normalize_metric_model(raw: JsonObject) -> JsonObject:
    model: JsonObject = {}
    for metric in METRIC_ORDER:
        value = raw.get(metric)
        if value is None:
            continue
        if isinstance(value, dict):
            entry: JsonObject = {}
            for source_key, target_key in (
                ("value", "value"),
                ("absolute", "value"),
                ("fixed", "value"),
                ("multiplier", "multiplier"),
                ("scale", "multiplier"),
                ("delta", "delta"),
                ("offset", "delta"),
                ("floor", "floor"),
                ("minimum", "floor"),
                ("ceiling", "ceiling"),
                ("maximum", "ceiling"),
            ):
                numeric = number_or_none(value.get(source_key))
                if numeric is not None:
                    entry[target_key] = numeric
            model[metric] = entry
            continue
        numeric = number_or_none(value)
        if numeric is not None:
            model[metric] = {"delta": numeric}
    return model


def validation_thresholds(config: JsonObject) -> JsonObject:
    raw_thresholds = config.get("thresholds", config.get("validationThresholds", {}))
    if not isinstance(raw_thresholds, dict):
        raw_thresholds = {}
    thresholds: JsonObject = {}
    for metric in METRIC_ORDER:
        raw = raw_thresholds.get(metric, {})
        thresholds[metric] = normalize_threshold(raw if isinstance(raw, dict) else {})
    return thresholds


def normalize_threshold(raw: JsonObject) -> JsonObject:
    max_degradation = first_number(raw, ("maxDegradation", "max_degradation", "allowedDegradation", "allowed_degradation"))
    max_degradation_ratio = first_number(
        raw,
        (
            "maxDegradationRatio",
            "max_degradation_ratio",
            "allowedDegradationRatio",
            "allowed_degradation_ratio",
        ),
    )
    minimum = first_number(raw, ("minimum", "min", "minCandidate", "min_candidate"))
    return {
        "maxDegradation": round_float(max_degradation if max_degradation is not None else 0),
        "maxDegradationRatio": round_float(max_degradation_ratio) if max_degradation_ratio is not None else None,
        "minimum": round_float(minimum) if minimum is not None else None,
    }


def first_number(raw: JsonObject, keys: Sequence[str]) -> float | None:
    for key in keys:
        numeric = number_or_none(raw.get(key))
        if numeric is not None:
            return numeric
    return None


def min_scenarios(config: JsonObject) -> int:
    value = number_or_none(config.get("minScenarios", config.get("min_scenarios")))
    if value is None:
        validation = config.get("validation")
        if isinstance(validation, dict):
            value = number_or_none(validation.get("minScenarios", validation.get("min_scenarios")))
    if value is None:
        return DEFAULT_MIN_SCENARIOS
    return max(1, int(value))


def resource_normalizer(config: JsonObject) -> float:
    for key in ("resourceNormalizer", "resource_normalizer"):
        value = number_or_none(config.get(key))
        if value is not None and value > 0:
            return value
    reward_model = config.get("rewardModel", config.get("reward_model"))
    if isinstance(reward_model, dict):
        for key in ("resourceNormalizer", "resource_normalizer"):
            value = number_or_none(reward_model.get(key))
            if value is not None and value > 0:
                return value
        normalizers = reward_model.get("normalizers")
        if isinstance(normalizers, dict):
            value = number_or_none(normalizers.get("resources"))
            if value is not None and value > 0:
                return value
    return DEFAULT_RESOURCE_NORMALIZER


def collect_historical_scenarios(
    paths: Sequence[str],
    *,
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    resource_normalizer_value: float = DEFAULT_RESOURCE_NORMALIZER,
) -> tuple[list[HistoricalScenario], JsonObject]:
    input_paths = list(paths) if paths else list(dataset_export.DEFAULT_INPUT_PATHS) + ["runtime-artifacts"]
    explicit_scenarios, explicit_metadata = collect_explicit_scenarios(input_paths, max_file_bytes, resource_normalizer_value)
    runtime_scenarios, runtime_metadata = collect_runtime_summary_scenarios(input_paths, max_file_bytes, resource_normalizer_value)

    scenarios_by_id: dict[str, HistoricalScenario] = {}
    for scenario in [*explicit_scenarios, *runtime_scenarios]:
        scenarios_by_id.setdefault(scenario.scenario_id, scenario)

    scenarios = sorted(scenarios_by_id.values(), key=lambda item: item.scenario_id)
    return scenarios, {
        "inputPaths": [dataset_export.display_path(Path(path).expanduser()) for path in input_paths],
        "explicit": explicit_metadata,
        "runtimeSummaries": runtime_metadata,
        "scenarioCount": len(scenarios),
    }


def collect_runtime_summary_scenarios(
    paths: Sequence[str],
    max_file_bytes: int,
    resource_normalizer_value: float,
) -> tuple[list[HistoricalScenario], JsonObject]:
    scan = dataset_export.collect_artifact_records(
        paths,
        max_file_bytes=max_file_bytes,
        excluded_directory_names=("node_modules", "__pycache__", ".git"),
        binary_file_extensions=(".png", ".jpg", ".jpeg", ".gif", ".sqlite", ".db", ".zip", ".gz", ".zst"),
        use_default_paths=False,
    )
    records_by_source: dict[str, list[Any]] = {}
    for record in scan.records:
        records_by_source.setdefault(record.source.source_id, []).append(record)

    scenarios: list[HistoricalScenario] = []
    for source_id, records in records_by_source.items():
        ticks = [normalize_runtime_summary_tick(record.payload) for record in records]
        ticks = [tick for tick in ticks if tick["rooms"]]
        if not ticks:
            continue
        source = SourceMetadata(
            source_id=source_id,
            path=records[0].source.display_path,
            artifact_kind="runtime-summary-replay",
        )
        baseline_metrics = metrics_from_tick_log(ticks, resource_normalizer_value)
        scenarios.append(
            HistoricalScenario(
                scenario_id=f"runtime-{canonical_hash({'sourceId': source_id, 'ticks': [tick.get('tick') for tick in ticks]})[:12]}",
                source=source,
                baseline_metrics=baseline_metrics,
                candidate_metrics=None,
                tick_count=len(ticks),
                room_names=tuple(sorted({room for tick in ticks for room in tick["rooms"]})),
                evidence_mode="historical-runtime-summary",
            )
        )

    return scenarios, {
        "scannedFiles": scan.scanned_files,
        "matchedArtifactCount": len(scan.records),
        "sourceFileCount": len(scan.source_files),
        "skippedFileCount": len(scan.skipped_files),
    }


def normalize_runtime_summary_tick(payload: JsonObject) -> JsonObject:
    rooms: dict[str, JsonObject] = {}
    raw_rooms = payload.get("rooms")
    if isinstance(raw_rooms, list):
        for raw_room in raw_rooms:
            if not isinstance(raw_room, dict):
                continue
            room_name = text_or_none(raw_room.get("roomName")) or text_or_none(raw_room.get("room"))
            if not room_name:
                continue
            rooms[room_name] = normalize_room_summary(raw_room, room_name)
    return {
        "tick": payload.get("tick"),
        "rooms": rooms,
        "cpu": payload.get("cpu") if isinstance(payload.get("cpu"), dict) else {},
        "reliability": payload.get("reliability") if isinstance(payload.get("reliability"), dict) else {},
    }


def normalize_room_summary(room: JsonObject, room_name: str) -> JsonObject:
    normalized = dict(room)
    normalized["roomName"] = room_name
    spawn_total = spawn_count(normalized)
    spawn_status = normalized.get("spawnStatus")
    if spawn_total == 0 and isinstance(spawn_status, list):
        spawn_total = sum(1 for item in spawn_status if isinstance(item, dict))
        if spawn_total > 0:
            normalized["ownedSpawnCount"] = spawn_total
    if creep_count(normalized) == 0:
        worker_count = number_or_none(normalized.get("workerCount"))
        if worker_count is not None:
            normalized["ownedCreepCount"] = worker_count

    controller = normalized.get("controller")
    if isinstance(controller, dict):
        normalized_controller = dict(controller)
        if (
            normalized_controller.get("my") is not True
            and normalized_controller.get("owned") is not True
            and not normalized_controller.get("owner")
            and (spawn_total > 0 or creep_count(normalized) > 0 or number_or_none(normalized_controller.get("level")) is not None)
        ):
            normalized_controller["my"] = True
        normalized["controller"] = normalized_controller
    elif spawn_total > 0 or creep_count(normalized) > 0:
        normalized["controller"] = {"my": True, "level": number_or_none(normalized.get("controllerLevel")) or 0}

    combat = normalized.get("combat")
    if isinstance(combat, dict):
        normalized_combat = dict(combat)
        events = normalized_combat.get("events")
        if isinstance(events, dict):
            normalized_events = dict(events)
            if "creepDestroyedCount" in normalized_events and "hostileCreepDestroyedCount" not in normalized_events:
                normalized_events["hostileCreepDestroyedCount"] = normalized_events["creepDestroyedCount"]
            if "objectDestroyedCount" in normalized_events and "hostileStructureDestroyedCount" not in normalized_events:
                normalized_events["hostileStructureDestroyedCount"] = normalized_events["objectDestroyedCount"]
            normalized_combat["events"] = normalized_events
        normalized["combat"] = normalized_combat

    return normalized


def collect_explicit_scenarios(
    paths: Sequence[str],
    max_file_bytes: int,
    resource_normalizer_value: float,
) -> tuple[list[HistoricalScenario], JsonObject]:
    scenarios: list[HistoricalScenario] = []
    scanned_files = 0
    matched_documents = 0
    skipped_files: list[JsonObject] = []

    for file_path in iter_candidate_files(paths, skipped_files, max_file_bytes):
        scanned_files += 1
        try:
            data = file_path.read_bytes()
        except OSError:
            skipped_files.append({"path": dataset_export.display_path(file_path), "reason": "read_error"})
            continue
        if b"\0" in data:
            skipped_files.append({"path": dataset_export.display_path(file_path), "reason": "binary"})
            continue
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            skipped_files.append({"path": dataset_export.display_path(file_path), "reason": "binary"})
            continue
        for line_number, document in dataset_export.iter_json_documents(text):
            parsed = scenarios_from_document(document, file_path, line_number, resource_normalizer_value)
            if parsed:
                matched_documents += 1
                scenarios.extend(parsed)

    return scenarios, {
        "scannedFiles": scanned_files,
        "matchedDocuments": matched_documents,
        "skippedFileCount": len(skipped_files),
        "skippedFiles": skipped_files[:20],
    }


def iter_candidate_files(paths: Sequence[str], skipped_files: list[JsonObject], max_file_bytes: int) -> Iterable[Path]:
    for raw_path in paths:
        path = Path(raw_path).expanduser()
        if not path.exists():
            skipped_files.append({"path": dataset_export.display_path(path), "reason": "missing"})
            continue
        if path.is_file():
            yield from maybe_yield_text_file(path, skipped_files, max_file_bytes)
            continue
        if path.is_dir():
            for dirpath, dirnames, filenames in os.walk(path, topdown=True, followlinks=False):
                dirnames[:] = [
                    name
                    for name in sorted(dirnames)
                    if name not in {"node_modules", "__pycache__", ".git"} and not name.startswith(".")
                ]
                for filename in sorted(filenames):
                    yield from maybe_yield_text_file(Path(dirpath) / filename, skipped_files, max_file_bytes)


def maybe_yield_text_file(path: Path, skipped_files: list[JsonObject], max_file_bytes: int) -> Iterable[Path]:
    if path.is_symlink():
        skipped_files.append({"path": dataset_export.display_path(path), "reason": "symlink"})
        return
    if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".sqlite", ".db", ".zip", ".gz", ".zst"}:
        skipped_files.append(
            {"path": dataset_export.display_path(path), "reason": "binary_extension", "extension": path.suffix.lower()}
        )
        return
    try:
        stat_result = path.stat()
    except OSError:
        skipped_files.append({"path": dataset_export.display_path(path), "reason": "read_error"})
        return
    if not path.is_file():
        skipped_files.append({"path": dataset_export.display_path(path), "reason": "not_regular_file"})
        return
    if stat_result.st_size > max_file_bytes:
        skipped_files.append(
            {
                "path": dataset_export.display_path(path),
                "reason": "oversized",
                "sizeBytes": stat_result.st_size,
                "maxFileBytes": max_file_bytes,
            }
        )
        return
    yield path


def scenarios_from_document(
    document: Any,
    file_path: Path,
    line_number: int | None,
    resource_normalizer_value: float,
) -> list[HistoricalScenario]:
    scenarios: list[HistoricalScenario] = []
    for item in flatten_json_documents(document):
        if not isinstance(item, dict):
            continue
        explicit = explicit_scenario_from_json(item, file_path, line_number)
        if explicit is not None:
            scenarios.append(explicit)
            continue
        scenarios.extend(explicit_scenarios_from_container(item, file_path, line_number))
        bridge = bridge_scenario_from_report(item, file_path, line_number, resource_normalizer_value)
        if bridge is not None:
            scenarios.append(bridge)
    return scenarios


def flatten_json_documents(document: Any) -> Iterable[Any]:
    if isinstance(document, list):
        for item in document:
            yield from flatten_json_documents(item)
        return
    yield document


def explicit_scenarios_from_container(raw: JsonObject, file_path: Path, line_number: int | None) -> list[HistoricalScenario]:
    scenarios: list[HistoricalScenario] = []
    raw_scenarios = raw.get("scenarios") or raw.get("historicalScenarios")
    if not isinstance(raw_scenarios, list):
        return scenarios
    for index, scenario in enumerate(raw_scenarios):
        if not isinstance(scenario, dict):
            continue
        parsed = explicit_scenario_from_json(
            scenario,
            file_path,
            line_number,
            fallback_id=f"{source_id_for_path(file_path)}-{index + 1}",
        )
        if parsed is not None:
            scenarios.append(parsed)
    return scenarios


def explicit_scenario_from_json(
    raw: JsonObject,
    file_path: Path,
    line_number: int | None,
    fallback_id: str | None = None,
) -> HistoricalScenario | None:
    baseline_metrics = raw_metrics(raw.get("baselineMetrics", nested_get(raw, ("metrics", "baseline"))))
    if baseline_metrics is None:
        return None
    candidate_metrics = raw_metrics(raw.get("candidateMetrics", nested_get(raw, ("metrics", "candidate"))))
    scenario_id = text_or_none(raw.get("scenarioId", raw.get("scenario_id"))) or fallback_id
    if not scenario_id:
        scenario_id = f"explicit-{canonical_hash({'path': str(file_path), 'line': line_number, 'baseline': baseline_metrics})[:12]}"
    source = SourceMetadata(
        source_id=source_id_for_path(file_path),
        path=dataset_export.display_path(file_path),
        artifact_kind="explicit-validation-scenario",
        line_number=line_number,
    )
    rooms = raw.get("roomNames", raw.get("rooms", []))
    room_names = tuple(sorted(room for room in rooms if isinstance(room, str))) if isinstance(rooms, list) else ()
    tick_count = int(number_or_none(raw.get("tickCount", raw.get("tick_count"))) or 0)
    return HistoricalScenario(
        scenario_id=dataset_export.redact_text(str(scenario_id)),
        source=source,
        baseline_metrics=baseline_metrics,
        candidate_metrics=candidate_metrics,
        tick_count=tick_count,
        room_names=room_names,
        evidence_mode="explicit-validation-scenario",
    )


def bridge_scenario_from_report(
    raw: JsonObject,
    file_path: Path,
    line_number: int | None,
    resource_normalizer_value: float,
) -> HistoricalScenario | None:
    if raw.get("type") != "runtime-kpi-report":
        return None
    baseline_metrics = metrics_from_bridge_report(raw, resource_normalizer_value)
    source = SourceMetadata(
        source_id=source_id_for_path(file_path),
        path=dataset_export.display_path(file_path),
        artifact_kind="artifact-bridge-kpi-report",
        line_number=line_number,
    )
    scenario_id = f"bridge-{canonical_hash({'source': source.to_json(), 'window': raw.get('window')})[:12]}"
    owned_rooms = nested_get(raw, ("territory", "ownedRooms", "latest"))
    room_names = tuple(sorted(room for room in owned_rooms if isinstance(room, str))) if isinstance(owned_rooms, list) else ()
    return HistoricalScenario(
        scenario_id=scenario_id,
        source=source,
        baseline_metrics=baseline_metrics,
        candidate_metrics=None,
        tick_count=int(number_or_none(nested_get(raw, ("input", "runtimeSummaryCount"))) or 0),
        room_names=room_names,
        evidence_mode="artifact-bridge-kpi-report",
    )


def raw_metrics(raw: Any) -> JsonObject | None:
    if not isinstance(raw, dict):
        return None
    metrics: JsonObject = {}
    for metric in METRIC_ORDER:
        value = number_or_none(raw.get(metric))
        if value is not None:
            metrics[metric] = round_float(value)
            continue
        nested = raw.get(metric)
        if isinstance(nested, dict):
            for key in ("score", "delta", "value"):
                value = number_or_none(nested.get(key))
                if value is not None:
                    metrics[metric] = round_float(value)
                    break
    if not metrics:
        return None
    return fill_missing_metrics(metrics)


def fill_missing_metrics(metrics: JsonObject) -> JsonObject:
    return {metric: round_float(number_or_none(metrics.get(metric)) or 0) for metric in METRIC_ORDER}


def source_id_for_path(path: Path) -> str:
    return f"src-{hashlib.sha256(str(path.resolve()).encode('utf-8')).hexdigest()[:12]}"


def nested_get(value: Any, keys: tuple[str, ...]) -> Any:
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def metrics_from_bridge_report(report: JsonObject, resource_normalizer_value: float) -> JsonObject:
    territory = number_or_none(nested_get(report, ("territory", "ownedRooms", "deltaCount"))) or 0
    controller_delta = nested_get(report, ("territory", "controllers", "totals", "delta"))
    if isinstance(controller_delta, dict):
        territory += (number_or_none(controller_delta.get("level")) or 0) / 100.0
        territory += (number_or_none(controller_delta.get("progress")) or 0) / 1_000_000.0

    resource_delta = nested_get(report, ("resources", "totals", "delta"))
    resource_events = report.get("resources", {}).get("eventDeltas") if isinstance(report.get("resources"), dict) else {}
    raw_resource = 0.0
    if isinstance(resource_delta, dict):
        for key in ("storedEnergy", "workerCarriedEnergy", "droppedEnergy"):
            raw_resource += number_or_none(resource_delta.get(key)) or 0
    if isinstance(resource_events, dict):
        for key in ("harvestedEnergy", "collectedEnergy", "pickupEnergy"):
            raw_resource += number_or_none(resource_events.get(key)) or 0

    combat_events = report.get("combat", {}).get("eventDeltas") if isinstance(report.get("combat"), dict) else {}
    kills = 0.0
    if isinstance(combat_events, dict):
        hostile_creep = number_or_none(combat_events.get("hostileCreepDestroyedCount"))
        generic_creep = number_or_none(combat_events.get("creepDestroyedCount"))
        kills += hostile_creep if hostile_creep is not None else (generic_creep or 0)
        hostile_structure = number_or_none(combat_events.get("hostileStructureDestroyedCount"))
        generic_object = number_or_none(combat_events.get("objectDestroyedCount"))
        kills += hostile_structure if hostile_structure is not None else (generic_object or 0)
        for key in ("ownCreepDestroyedCount", "ownStructureDestroyedCount"):
            kills -= number_or_none(combat_events.get(key)) or 0

    runtime_count = number_or_none(nested_get(report, ("input", "runtimeSummaryCount"))) or 0
    malformed = number_or_none(nested_get(report, ("input", "malformedRuntimeSummaryCount"))) or 0
    reliability = 0 if runtime_count <= 0 else clamp(1.0 - (malformed / max(1.0, runtime_count)), 0, 1)
    return fill_missing_metrics(
        {
            "reliability": reliability,
            "territory": territory,
            "resources": raw_resource / resource_normalizer_value,
            "kills": kills,
        }
    )


def metrics_from_tick_log(ticks: Sequence[JsonObject], resource_normalizer_value: float) -> JsonObject:
    if not ticks:
        return fill_missing_metrics({})
    first_rooms = tick_rooms(ticks[0])
    final_rooms = tick_rooms(ticks[-1])
    initial_held = {room for room, summary in first_rooms.items() if room_is_held(summary)}
    final_held = {room for room, summary in final_rooms.items() if room_is_held(summary)}
    territory = len(final_held) - len(initial_held)
    territory += (rooms_rcl(final_rooms) - rooms_rcl(first_rooms)) / 100.0
    territory += (rooms_controller_progress(final_rooms) - rooms_controller_progress(first_rooms)) / 1_000_000.0

    stored_energy_delta = rooms_energy(final_rooms) - rooms_energy(first_rooms)
    collected_energy = sum(extract_collected_energy(tick) for tick in ticks)
    kills = sum(extract_hostile_kills(tick) for tick in ticks) - sum(extract_own_losses(tick) for tick in ticks)
    reliability = reliability_score(ticks)
    return fill_missing_metrics(
        {
            "reliability": reliability,
            "territory": territory,
            "resources": (stored_energy_delta + collected_energy) / resource_normalizer_value,
            "kills": kills,
        }
    )


def tick_rooms(tick: JsonObject) -> dict[str, JsonObject]:
    rooms = tick.get("rooms")
    return rooms if isinstance(rooms, dict) else {}


def room_is_held(room: JsonObject) -> bool:
    if room.get("claimed") is True or room.get("owned") is True or room.get("my") is True:
        return True
    controller = room.get("controller")
    if isinstance(controller, dict):
        if controller.get("my") is True or controller.get("owned") is True or controller.get("owner"):
            return True
    return spawn_count(room) > 0 or creep_count(room) > 0


def spawn_count(room: JsonObject) -> int:
    for key in ("owned_spawns", "ownedSpawnCount", "spawnCount", "spawns"):
        value = number_or_none(room.get(key))
        if value is not None:
            return int(value)
    structures = room.get("structures")
    if isinstance(structures, dict):
        for key in ("spawn", "STRUCTURE_SPAWN"):
            value = number_or_none(structures.get(key))
            if value is not None:
                return int(value)
    spawn_status = room.get("spawnStatus")
    if isinstance(spawn_status, list):
        return sum(1 for item in spawn_status if isinstance(item, dict))
    monitor = room.get("monitor")
    if isinstance(monitor, dict):
        value = number_or_none(monitor.get("ownedSpawnCount"))
        if value is not None:
            return int(value)
    return 0


def creep_count(room: JsonObject) -> int:
    for key in ("owned_creeps", "ownedCreeps", "ownedCreepCount", "creeps", "workerCount"):
        value = number_or_none(room.get(key))
        if value is not None:
            return int(value)
    workers = room.get("workers")
    if isinstance(workers, dict):
        value = number_or_none(workers.get("count"))
        if value is not None:
            return int(value)
    return 0


def controller_level(room: JsonObject) -> float:
    controller = room.get("controller")
    if isinstance(controller, dict):
        value = number_or_none(controller.get("level"))
        if value is not None:
            return value
    return number_or_none(room.get("rcl", room.get("controllerLevel"))) or 0


def controller_progress(room: JsonObject) -> float:
    controller = room.get("controller")
    if isinstance(controller, dict):
        value = number_or_none(controller.get("progress"))
        if value is not None:
            return value
    return number_or_none(room.get("controllerProgress")) or 0


def rooms_rcl(rooms: dict[str, JsonObject]) -> float:
    return sum(controller_level(room) for room in rooms.values())


def rooms_controller_progress(rooms: dict[str, JsonObject]) -> float:
    return sum(controller_progress(room) for room in rooms.values())


def rooms_energy(rooms: dict[str, JsonObject]) -> float:
    return sum(room_energy(room) for room in rooms.values())


def room_energy(room: JsonObject) -> float:
    total = 0.0
    for key in ("storedEnergy", "stored_energy", "energy", "energyAvailable"):
        value = number_or_none(room.get(key))
        if value is not None:
            total += value
            break
    resources = room.get("resources")
    if isinstance(resources, dict):
        for key in ("storedEnergy", "workerCarriedEnergy", "droppedEnergy"):
            total += number_or_none(resources.get(key)) or 0
    storage = room.get("storage")
    if isinstance(storage, dict):
        store = storage.get("store")
        if isinstance(store, dict):
            total += number_or_none(store.get("energy")) or 0
        else:
            total += number_or_none(storage.get("energy")) or 0
    terminal = room.get("terminal")
    if isinstance(terminal, dict):
        store = terminal.get("store")
        if isinstance(store, dict):
            total += number_or_none(store.get("energy")) or 0
    return total


def extract_collected_energy(tick: JsonObject) -> float:
    total = 0.0
    for room in tick_rooms(tick).values():
        resources = room.get("resources")
        if isinstance(resources, dict):
            events = resources.get("events")
            if isinstance(events, dict):
                for key in ("harvestedEnergy", "collectedEnergy", "pickupEnergy"):
                    total += number_or_none(events.get(key)) or 0
        events = room.get("events")
        if isinstance(events, dict):
            for key in ("harvestedEnergy", "collectedEnergy", "pickupEnergy"):
                total += number_or_none(events.get(key)) or 0
    return total


def extract_hostile_kills(tick: JsonObject) -> float:
    total = 0.0
    for room in tick_rooms(tick).values():
        combat = room.get("combat")
        if not isinstance(combat, dict):
            continue
        events = combat.get("events")
        if isinstance(events, dict):
            hostile_creep = number_or_none(events.get("hostileCreepDestroyedCount"))
            generic_creep = number_or_none(events.get("creepDestroyedCount"))
            total += hostile_creep if hostile_creep is not None else (generic_creep or 0)
            hostile_structure = number_or_none(events.get("hostileStructureDestroyedCount"))
            generic_object = number_or_none(events.get("objectDestroyedCount"))
            total += hostile_structure if hostile_structure is not None else (generic_object or 0)
            continue
        combined = number_or_none(combat.get("hostileKills"))
        if combined is not None:
            total += combined
            continue
        for key in ("hostileCreepKills", "hostileStructureKills"):
            total += number_or_none(combat.get(key)) or 0
    return total


def extract_own_losses(tick: JsonObject) -> float:
    total = 0.0
    for room in tick_rooms(tick).values():
        combat = room.get("combat")
        if not isinstance(combat, dict):
            continue
        events = combat.get("events")
        if isinstance(events, dict):
            for key in ("ownCreepDestroyedCount", "ownStructureDestroyedCount"):
                total += number_or_none(events.get(key)) or 0
            continue
        combined = number_or_none(combat.get("ownLosses"))
        if combined is not None:
            total += combined
            continue
        for key in ("ownCreepLosses", "ownStructureLosses"):
            total += number_or_none(combat.get(key)) or 0
    return total


def reliability_score(ticks: Sequence[JsonObject]) -> float:
    if not ticks:
        return 0
    failures = 0.0
    silence_ticks = 0.0
    low_bucket_count = 0
    for tick in ticks:
        reliability = tick.get("reliability")
        if isinstance(reliability, dict):
            for key in ("loopExceptionCount", "exceptionCount", "errorCount", "uncaughtExceptionCount"):
                failures += number_or_none(reliability.get(key)) or 0
            silence_ticks += number_or_none(reliability.get("telemetrySilenceTicks")) or 0
        cpu = tick.get("cpu")
        if isinstance(cpu, dict):
            bucket = number_or_none(cpu.get("bucket"))
            if bucket is not None and bucket < 500:
                low_bucket_count += 1
    failure_penalty = failures / max(1.0, float(len(ticks)))
    silence_penalty = min(1.0, silence_ticks / max(1.0, float(len(ticks) * 100)))
    cpu_penalty = low_bucket_count / max(1.0, float(len(ticks) * 2))
    return round(float(clamp(1.0 - failure_penalty - silence_penalty - cpu_penalty, 0, 1)), 6)


def apply_metric_model(base_metrics: JsonObject, model: JsonObject) -> JsonObject:
    projected: JsonObject = {}
    for metric in METRIC_ORDER:
        base_value = float(number_or_none(base_metrics.get(metric)) or 0)
        entry = model.get(metric)
        if not isinstance(entry, dict):
            projected[metric] = round_float(base_value)
            continue
        value = number_or_none(entry.get("value"))
        if value is None:
            value = base_value
            multiplier = number_or_none(entry.get("multiplier"))
            if multiplier is not None:
                value *= multiplier
            value += number_or_none(entry.get("delta")) or 0
        floor = number_or_none(entry.get("floor"))
        if floor is not None:
            value = max(value, floor)
        ceiling = number_or_none(entry.get("ceiling"))
        if ceiling is not None:
            value = min(value, ceiling)
        if metric == "reliability":
            value = clamp(value, 0, 1)
        projected[metric] = round_float(value)
    return projected


def compare_metric(
    metric: str,
    baseline_value: float | int,
    candidate_value: float | int,
    threshold: JsonObject | None = None,
    *,
    scope: str = "aggregate",
    scenario_id: str | None = None,
) -> JsonObject:
    threshold = threshold or normalize_threshold({})
    baseline = float(baseline_value)
    candidate = float(candidate_value)
    delta = candidate - baseline if HIGHER_IS_BETTER[metric] else baseline - candidate
    degradation = max(0.0, -delta)
    degradation_ratio = degradation / abs(baseline) if degradation > 0 and baseline != 0 else None
    max_degradation = float(number_or_none(threshold.get("maxDegradation")) or 0)
    max_degradation_ratio = number_or_none(threshold.get("maxDegradationRatio"))
    minimum = number_or_none(threshold.get("minimum"))
    flags: list[str] = []
    if degradation > max_degradation:
        flags.append("absolute_degradation")
    if max_degradation_ratio is not None and degradation_ratio is not None and degradation_ratio > max_degradation_ratio:
        flags.append("relative_degradation")
    if minimum is not None and candidate < minimum:
        flags.append("below_minimum")

    return {
        "metric": metric,
        "scope": scope,
        **({"scenarioId": scenario_id} if scenario_id is not None else {}),
        "baseline": round_float(baseline),
        "candidate": round_float(candidate),
        "delta": round_float(candidate - baseline),
        "degradation": round_float(degradation),
        "degradationRatio": round_float(degradation_ratio),
        "threshold": threshold,
        "passed": not flags,
        "degraded": degradation > 0,
        "flags": flags,
    }


def aggregate_scenario_metrics(scenarios: Sequence[JsonObject], side: str) -> JsonObject:
    if not scenarios:
        return fill_missing_metrics({})
    aggregate: JsonObject = {}
    for metric in METRIC_ORDER:
        values = [float(scenario[f"{side}Metrics"][metric]) for scenario in scenarios]
        if metric == "reliability":
            aggregate[metric] = round_float(min(values))
        else:
            aggregate[metric] = round_float(sum(values) / len(values))
    return aggregate


def validate_candidate_against_history(
    candidate_config_path: Path,
    historical_paths: Sequence[str],
    *,
    out_dir: Path | None = DEFAULT_OUT_DIR,
    report_id: str | None = None,
    generated_at: str | None = None,
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
) -> JsonObject:
    config = load_candidate_config(candidate_config_path)
    normalizer = resource_normalizer(config)
    scenarios, source_metadata = collect_historical_scenarios(
        historical_paths,
        max_file_bytes=max_file_bytes,
        resource_normalizer_value=normalizer,
    )
    candidate_model = metric_model(config, side="candidate")
    baseline_model = metric_model(config, side="baseline")
    thresholds = validation_thresholds(config)
    required_scenarios = min_scenarios(config)

    scenario_results = []
    degradation_flags: list[JsonObject] = []
    for scenario in scenarios:
        baseline_metrics = apply_metric_model(scenario.baseline_metrics, baseline_model)
        candidate_metrics = (
            fill_missing_metrics(scenario.candidate_metrics)
            if scenario.candidate_metrics is not None
            else apply_metric_model(baseline_metrics, candidate_model)
        )
        metric_reports = {
            metric: compare_metric(
                metric,
                float(baseline_metrics[metric]),
                float(candidate_metrics[metric]),
                thresholds[metric],
                scope="scenario",
                scenario_id=scenario.scenario_id,
            )
            for metric in METRIC_ORDER
        }
        for metric_report in metric_reports.values():
            if not metric_report["passed"]:
                degradation_flags.append(degradation_flag(metric_report))
        scenario_results.append(
            {
                **scenario.to_json(),
                "baselineMetrics": baseline_metrics,
                "candidateMetrics": candidate_metrics,
                "metricReports": metric_reports,
            }
        )

    aggregate_baseline = aggregate_scenario_metrics(scenario_results, "baseline")
    aggregate_candidate = aggregate_scenario_metrics(scenario_results, "candidate")
    aggregate_metric_reports = {
        metric: compare_metric(
            metric,
            float(aggregate_baseline[metric]),
            float(aggregate_candidate[metric]),
            thresholds[metric],
        )
        for metric in METRIC_ORDER
    }
    for metric_report in aggregate_metric_reports.values():
        if not metric_report["passed"]:
            degradation_flags.append(degradation_flag(metric_report))

    metric_reports = build_metric_reports(aggregate_metric_reports, scenario_results)
    scenario_count = len(scenario_results)
    insufficient_data = scenario_count < required_scenarios
    all_metrics_pass = not insufficient_data and all(report["passed"] for report in metric_reports.values())
    recommendation = build_recommendation(
        scenario_count=scenario_count,
        required_scenarios=required_scenarios,
        metric_reports=metric_reports,
        aggregate_baseline=aggregate_baseline,
        aggregate_candidate=aggregate_candidate,
    )
    resolved_report_id = report_id or default_report_id(config, source_metadata, aggregate_baseline, aggregate_candidate)
    report = {
        "ok": all_metrics_pass,
        "type": REPORT_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "reportId": resolved_report_id,
        "generatedAt": generated_at or utc_now_iso(),
        "owningIssue": "#550",
        "status": "passed" if all_metrics_pass else ("insufficient_data" if insufficient_data else "failed"),
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
        "candidate": {
            "strategyId": candidate_strategy_id(config),
            "configPath": dataset_export.display_path(candidate_config_path),
            "configHash": canonical_hash(config),
            "metricModel": candidate_model,
        },
        "baseline": {
            "strategyId": baseline_strategy_id(config),
            "metricModel": baseline_model,
        },
        "validation": {
            "mode": "historical-official-mmo-replay",
            "metricOrder": list(METRIC_ORDER),
            "resourceNormalizer": normalizer,
            "minScenarios": required_scenarios,
            "scenarioCount": scenario_count,
            "thresholds": thresholds,
        },
        "source": source_metadata,
        "aggregate": {
            "baselineMetrics": aggregate_baseline,
            "candidateMetrics": aggregate_candidate,
            "metricReports": aggregate_metric_reports,
        },
        "metrics": metric_reports,
        "degradationFlags": degradation_flags,
        "scenarioResults": scenario_results,
        "recommendation": recommendation,
        "rlSteward": {
            "machineReadable": True,
            "decision": recommendation["decision"],
            "pass": all_metrics_pass,
            "blockingMetrics": [
                metric for metric, metric_report in metric_reports.items() if not metric_report["passed"]
            ],
        },
    }
    assert_no_secret_leak(report, dataset_export.configured_secret_values())
    if out_dir is not None:
        report_path = out_dir.expanduser() / f"{resolved_report_id}.json"
        write_json_atomic(report_path, report)
        report["reportPath"] = dataset_export.display_path(report_path)
    return report


def degradation_flag(metric_report: JsonObject) -> JsonObject:
    return {
        "metric": metric_report["metric"],
        "scope": metric_report["scope"],
        **({"scenarioId": metric_report["scenarioId"]} if "scenarioId" in metric_report else {}),
        "baseline": metric_report["baseline"],
        "candidate": metric_report["candidate"],
        "delta": metric_report["delta"],
        "degradation": metric_report["degradation"],
        "degradationRatio": metric_report["degradationRatio"],
        "flags": metric_report["flags"],
    }


def build_metric_reports(aggregate_reports: JsonObject, scenario_results: Sequence[JsonObject]) -> JsonObject:
    reports: JsonObject = {}
    for metric in METRIC_ORDER:
        scenario_metric_reports = [scenario["metricReports"][metric] for scenario in scenario_results]
        failed_scenarios = [report for report in scenario_metric_reports if not report["passed"]]
        aggregate = dict(aggregate_reports[metric])
        aggregate["scenarioFailureCount"] = len(failed_scenarios)
        aggregate["failedScenarioIds"] = [report["scenarioId"] for report in failed_scenarios]
        aggregate["passed"] = bool(aggregate["passed"]) and not failed_scenarios
        reports[metric] = aggregate
    return reports


def build_recommendation(
    *,
    scenario_count: int,
    required_scenarios: int,
    metric_reports: JsonObject,
    aggregate_baseline: JsonObject,
    aggregate_candidate: JsonObject,
) -> JsonObject:
    if scenario_count < required_scenarios:
        return {
            "decision": "needs_more_data",
            "advance": False,
            "reason": f"only {scenario_count} historical scenario(s), requires {required_scenarios}",
        }

    failed_metrics = [metric for metric, report in metric_reports.items() if not report["passed"]]
    if failed_metrics:
        return {
            "decision": "reject",
            "advance": False,
            "reason": "metric degradation detected: " + ", ".join(failed_metrics),
        }

    reward_comparison = compare_reward_tuple(aggregate_candidate, aggregate_baseline)
    if reward_comparison > 0:
        return {
            "decision": "advance_to_kpi_shadow_gate",
            "advance": True,
            "reason": "candidate passes historical MMO validation and improves the lexicographic objective",
        }
    if reward_comparison == 0:
        return {
            "decision": "keep_incumbent",
            "advance": False,
            "reason": "candidate passes non-regression checks but does not improve the incumbent",
        }
    return {
        "decision": "reject",
        "advance": False,
        "reason": "candidate is lexicographically worse than the incumbent",
    }


def compare_reward_tuple(candidate: JsonObject, baseline: JsonObject) -> int:
    if float(candidate["reliability"]) < float(baseline["reliability"]):
        return -1
    for metric in ("territory", "resources", "kills"):
        candidate_value = float(candidate[metric])
        baseline_value = float(baseline[metric])
        if candidate_value > baseline_value:
            return 1
        if candidate_value < baseline_value:
            return -1
    return 0


def safety_metadata() -> JsonObject:
    return {
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "officialMmoControl": False,
        "liveApiCalls": False,
        "liveSecretsRequired": False,
        "memoryWritesAllowed": False,
        "rawMemoryWritesAllowed": False,
        "rawCreepIntentControl": False,
        "spawnIntentControl": False,
        "constructionIntentControl": False,
        "marketIntentControl": False,
        "allowedUse": "offline RL steward validation and shadow-gate recommendations only",
    }


def default_report_id(config: JsonObject, source_metadata: JsonObject, baseline: JsonObject, candidate: JsonObject) -> str:
    seed = {
        "configHash": canonical_hash(config),
        "source": source_metadata,
        "baseline": baseline,
        "candidate": candidate,
    }
    return f"{REPORT_ID_PREFIX}-{canonical_hash(seed)[:12]}"


def assert_no_secret_leak(payload: JsonObject, secrets: Sequence[str]) -> None:
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=True)
    for secret in secrets:
        if secret and len(secret) >= 6 and secret in encoded:
            raise RuntimeError("refusing to persist MMO validation report containing a configured secret")


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
        "ok": report["ok"],
        "type": SUMMARY_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "reportId": report["reportId"],
        "reportPath": report.get("reportPath"),
        "status": report["status"],
        "candidateStrategyId": report["candidate"]["strategyId"],
        "baselineStrategyId": report["baseline"]["strategyId"],
        "scenarioCount": report["validation"]["scenarioCount"],
        "decision": report["recommendation"]["decision"],
        "advance": report["recommendation"]["advance"],
        "degradationFlags": report["degradationFlags"],
    }


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate an RL candidate strategy against historical official-MMO runtime artifacts.",
    )
    parser.add_argument("--candidate-config", required=True, type=Path, help="Candidate strategy configuration JSON.")
    parser.add_argument(
        "paths",
        nargs="*",
        help="Historical runtime artifact files/directories. Defaults to runtime-artifacts and artifact bridge roots.",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_OUT_DIR,
        help=f"Validation report output directory. Default: {DEFAULT_OUT_DIR}.",
    )
    parser.add_argument("--report-id", help="Optional validation report file stem.")
    parser.add_argument(
        "--max-file-bytes",
        type=positive_int,
        default=DEFAULT_MAX_FILE_BYTES,
        help=f"Skip files larger than this many bytes. Default: {DEFAULT_MAX_FILE_BYTES}.",
    )
    parser.add_argument(
        "--print-report",
        action="store_true",
        help="Print the full validation report instead of the compact generation summary.",
    )
    parser.add_argument(
        "--stdout-only",
        action="store_true",
        help="Do not write a report file; emit JSON only on stdout.",
    )
    return parser


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    args = build_parser().parse_args(argv)
    try:
        report = validate_candidate_against_history(
            args.candidate_config,
            args.paths,
            out_dir=None if args.stdout_only else args.out_dir,
            report_id=args.report_id,
            max_file_bytes=args.max_file_bytes,
        )
        stdout.write(canonical_json(report if args.print_report else build_generation_summary(report)))
        return 0 if bool(report.get("ok")) else 1
    except (ValidationConfigError, RuntimeError, OSError) as error:
        stderr.write(f"error: {error}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
