#!/usr/bin/env python3
"""Build a standardized RL/gameplay scorecard from Screeps evaluation artifacts."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence, TextIO


SCHEMA_VERSION = 1
REPORT_TYPE = "screeps-rl-evaluation-scorecard"
DEFAULT_OUT_DIR = Path("runtime-artifacts/rl-control-loop/scorecards")
RUNTIME_SUMMARY_PREFIX = "#runtime-summary "
EPSILON = 1e-9
MAX_REFERENCED_ARTIFACTS = 200
PREFLIGHT_FINAL_STATUS_KEYS = {
    "preflight",
    "preflightok",
    "preflightonly",
    "preflightpassed",
    "preflightvalidated",
}
STRONG_TRAINING_REPORT_KEYS = {
    "trainingreport",
    "trainingreportid",
    "trainingreportids",
    "trainingreportpath",
    "trainingreportpaths",
    "trainingreports",
}
ENVIRONMENT_RUN_COUNT_KEYS = {
    "completedenvironmentruns",
    "completedenvironments",
    "environmentruns",
    "environmentscompleted",
    "environmentsrun",
}

STATUS_IMPROVED = "improved"
STATUS_NEUTRAL = "neutral"
STATUS_REGRESSED = "regressed"
STATUS_INCONCLUSIVE = "inconclusive"
GATE_PASS = "PASS"
GATE_FAIL = "FAIL"
GATE_INCONCLUSIVE = "INCONCLUSIVE"

JsonObject = dict[str, Any]


class ScorecardError(ValueError):
    """Raised when a scorecard input cannot be read safely."""


@dataclass(frozen=True)
class MetricSpec:
    key: str
    direction: str
    label: str
    unit: str
    aggregation: str
    safety_floor: bool = False
    maximum: float | None = None
    minimum: float | None = None
    tolerance: float = EPSILON


@dataclass(frozen=True)
class DimensionSpec:
    key: str
    label: str
    safety: bool
    metric_keys: tuple[str, ...]
    missing_behavior: str = "inconclusive"


@dataclass(frozen=True)
class MetricObservation:
    value: float
    source: str
    note: str


METRIC_SPECS: dict[str, MetricSpec] = {
    "gate_pass": MetricSpec("gate_pass", "higher", "E1/shadow gate pass", "0/1", "min", True, minimum=1),
    "loop_exception_count": MetricSpec(
        "loop_exception_count", "lower", "runtime loop exceptions", "count", "sum", True, maximum=0
    ),
    "room_dead_count": MetricSpec("room_dead_count", "lower", "room_dead signals", "count", "sum", True, maximum=0),
    "spawn_collapse_count": MetricSpec(
        "spawn_collapse_count", "lower", "spawn collapse signals", "count", "sum", True, maximum=0
    ),
    "telemetry_silence_ticks": MetricSpec(
        "telemetry_silence_ticks", "lower", "telemetry silence", "ticks", "sum", True
    ),
    "cpu_bucket_min": MetricSpec("cpu_bucket_min", "higher", "minimum CPU bucket", "bucket", "min", True, minimum=500),
    "cpu_used_avg": MetricSpec("cpu_used_avg", "lower", "average CPU used", "cpu", "mean", True),
    "owned_room_count": MetricSpec("owned_room_count", "higher", "owned room count", "rooms", "latest"),
    "controller_progress": MetricSpec("controller_progress", "higher", "controller progress", "progress", "latest"),
    "controller_level_sum": MetricSpec("controller_level_sum", "higher", "controller level sum", "levels", "latest"),
    "expansion_survival_count": MetricSpec(
        "expansion_survival_count", "higher", "rooms with spawn and creep survival", "rooms", "latest"
    ),
    "harvested_energy": MetricSpec("harvested_energy", "higher", "harvest throughput", "energy", "sum"),
    "stored_energy": MetricSpec("stored_energy", "higher", "stored energy", "energy", "latest"),
    "energy_surplus": MetricSpec("energy_surplus", "higher", "energy surplus", "energy", "latest"),
    "productive_energy": MetricSpec(
        "productive_energy", "higher", "productive build/repair/upgrade energy", "energy", "sum"
    ),
    "build_progress": MetricSpec("build_progress", "higher", "build progress", "progress", "sum"),
    "defense_infrastructure": MetricSpec(
        "defense_infrastructure", "higher", "tower/rampart defense infrastructure", "count", "latest"
    ),
    "stale_candidate": MetricSpec("stale_candidate", "lower", "stale candidate indicator", "0/1", "max"),
    "low_load_return_count": MetricSpec(
        "low_load_return_count", "lower", "low-load return count", "count", "sum"
    ),
    "return_load_factor": MetricSpec("return_load_factor", "higher", "return load factor", "ratio", "mean"),
    "combat_score": MetricSpec("combat_score", "higher", "hostile kills minus own losses", "score", "sum"),
    "hostile_pressure": MetricSpec("hostile_pressure", "lower", "hostile pressure", "hostiles", "max"),
}

DIMENSION_SPECS: dict[str, DimensionSpec] = {
    "safety_reliability_floor": DimensionSpec(
        "safety_reliability_floor",
        "Safety/reliability floor",
        True,
        (
            "gate_pass",
            "loop_exception_count",
            "room_dead_count",
            "spawn_collapse_count",
            "telemetry_silence_ticks",
            "cpu_bucket_min",
            "cpu_used_avg",
        ),
    ),
    "territory_expansion": DimensionSpec(
        "territory_expansion",
        "Territory/expansion",
        False,
        ("owned_room_count", "controller_progress", "controller_level_sum", "expansion_survival_count"),
    ),
    "resources_economy": DimensionSpec(
        "resources_economy",
        "Resources/economy",
        False,
        ("harvested_energy", "stored_energy", "energy_surplus", "productive_energy"),
    ),
    "construction_infrastructure": DimensionSpec(
        "construction_infrastructure",
        "Construction/infrastructure",
        False,
        ("build_progress", "defense_infrastructure", "stale_candidate"),
    ),
    "creep_efficiency": DimensionSpec(
        "creep_efficiency",
        "Creep efficiency",
        False,
        ("low_load_return_count", "return_load_factor"),
    ),
    "combat": DimensionSpec(
        "combat",
        "Combat",
        False,
        ("combat_score", "hostile_pressure"),
        missing_behavior="not_applicable",
    ),
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    ).hexdigest()


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


def display_path(path: Path | str, repo_root: Path | None = None) -> str:
    text = str(path)
    if any(marker in text.lower() for marker in ("token", "secret", "password", "steam_key")):
        return "[redacted-path]"
    try:
        resolved = Path(path).expanduser().resolve()
        root = (repo_root or Path.cwd()).resolve()
        return str(resolved.relative_to(root))
    except (OSError, ValueError):
        return text


def number_value(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        parsed = float(value)
    elif isinstance(value, str):
        try:
            parsed = float(value)
        except ValueError:
            return None
    else:
        return None
    if not math.isfinite(parsed):
        return None
    return parsed


def text_value(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def as_dict(value: Any) -> JsonObject:
    return value if isinstance(value, dict) else {}


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def path_value(raw: Any, path: tuple[str, ...]) -> Any:
    value = raw
    for part in path:
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


def first_number(raw: Any, paths: Sequence[tuple[str, ...]]) -> float | None:
    for path in paths:
        value = number_value(path_value(raw, path))
        if value is not None:
            return value
    return None


def normalized_key(value: str) -> str:
    return "".join(character for character in value.lower() if character.isalnum())


def iter_json_objects(value: Any) -> Iterable[JsonObject]:
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from iter_json_objects(item)
    elif isinstance(value, list):
        for item in value:
            yield from iter_json_objects(item)


def value_has_reference(value: Any) -> bool:
    if isinstance(value, str):
        return bool(value)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return True
    if isinstance(value, dict):
        return any(value_has_reference(item) for item in value.values())
    if isinstance(value, list):
        return any(value_has_reference(item) for item in value)
    return False


def positive_count(value: Any) -> int | None:
    parsed = number_value(value)
    if parsed is None or parsed <= 0:
        return None
    return int(parsed)


def controller_summary_final_status_key(node: JsonObject) -> str:
    raw = text_value(path_value(node, ("finalStatus",))) or text_value(path_value(node, ("final_status",)))
    return normalized_key(raw) if raw is not None else ""


def node_looks_like_controller_summary(node: JsonObject) -> bool:
    if node.get("type") == "screeps-tencent-batch-rl-run":
        return True
    return any(key in node for key in ("finalStatus", "final_status")) and any(
        key in node for key in ("instanceId", "instance_id", "environmentsRun", "outputs")
    )


def preflight_marker_present(payload: JsonObject) -> bool:
    return any(
        controller_summary_final_status_key(node) in PREFLIGHT_FINAL_STATUS_KEYS
        for node in iter_json_objects(payload)
    )


def real_compute_evidence_present(payload: JsonObject) -> bool:
    for node in iter_json_objects(payload):
        for key, raw in node.items():
            normalized = normalized_key(str(key))
            if normalized in STRONG_TRAINING_REPORT_KEYS and value_has_reference(raw):
                return True
            if normalized in ENVIRONMENT_RUN_COUNT_KEYS and positive_count(raw) is not None:
                return True
            if normalized == "environmentexecution":
                execution = as_dict(raw)
                if (
                    positive_count(execution.get("completed")) is not None
                    or positive_count(execution.get("Completed")) is not None
                    or positive_count(execution.get("completedCount")) is not None
                ):
                    return True

        if not node_looks_like_controller_summary(node):
            continue
        final_status = controller_summary_final_status_key(node)
        if final_status in PREFLIGHT_FINAL_STATUS_KEYS:
            continue
        if text_value(node.get("instanceId")) is not None or text_value(node.get("instance_id")) is not None:
            return True
    return False


def preflight_only_compute_payload(payload: JsonObject) -> bool:
    return preflight_marker_present(payload) and not real_compute_evidence_present(payload)


def find_first_number_by_keys(value: Any, key_names: Sequence[str]) -> float | None:
    wanted = {normalized_key(name) for name in key_names}
    if isinstance(value, dict):
        for key, item in value.items():
            if normalized_key(str(key)) in wanted:
                found = number_value(item)
                if found is not None:
                    return found
            found = find_first_number_by_keys(item, key_names)
            if found is not None:
                return found
    elif isinstance(value, list):
        for item in value:
            found = find_first_number_by_keys(item, key_names)
            if found is not None:
                return found
    return None


def sum_numbers_by_keys(value: Any, key_names: Sequence[str]) -> tuple[float, bool]:
    wanted = {normalized_key(name) for name in key_names}
    total = 0.0
    seen = False
    if isinstance(value, dict):
        for key, item in value.items():
            if normalized_key(str(key)) in wanted:
                found = number_value(item)
                if found is not None:
                    total += found
                    seen = True
                    continue
            child_total, child_seen = sum_numbers_by_keys(item, key_names)
            if child_seen:
                total += child_total
                seen = True
    elif isinstance(value, list):
        for item in value:
            child_total, child_seen = sum_numbers_by_keys(item, key_names)
            if child_seen:
                total += child_total
                seen = True
    return total, seen


class MetricAccumulator:
    def __init__(self) -> None:
        self._values: dict[str, list[MetricObservation]] = {}

    def add(self, key: str, value: Any, source: str, note: str) -> None:
        parsed = number_value(value)
        if parsed is None:
            return
        self._values.setdefault(key, []).append(MetricObservation(parsed, source, note))

    def has(self, key: str) -> bool:
        return bool(self._values.get(key))

    def summarize(self) -> dict[str, JsonObject]:
        summarized: dict[str, JsonObject] = {}
        for key, observations in sorted(self._values.items()):
            spec = METRIC_SPECS.get(key)
            if spec is None or not observations:
                continue
            value = aggregate_metric(spec.aggregation, [observation.value for observation in observations])
            summarized[key] = {
                "aggregation": spec.aggregation,
                "label": spec.label,
                "unit": spec.unit,
                "value": round_float(value),
                "sampleCount": len(observations),
                "evidence": [
                    {
                        "source": observation.source,
                        "value": round_float(observation.value),
                        "note": observation.note,
                    }
                    for observation in observations[:5]
                ],
            }
        return summarized


def aggregate_metric(aggregation: str, values: Sequence[float]) -> float:
    if aggregation == "sum":
        return sum(values)
    if aggregation == "min":
        return min(values)
    if aggregation == "max":
        return max(values)
    if aggregation == "mean":
        return sum(values) / len(values)
    if aggregation == "latest":
        return values[-1]
    raise ScorecardError(f"unknown metric aggregation: {aggregation}")


def round_float(value: float | int) -> float | int:
    numeric = float(value)
    if math.isfinite(numeric) and numeric.is_integer():
        return int(numeric)
    return round(numeric, 6)


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise ScorecardError(f"could not read {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise ScorecardError(f"{path} is not valid JSON: {error}") from error


def iter_artifact_files(root: Path) -> Iterable[Path]:
    if root.is_file():
        yield root
        return
    if not root.is_dir():
        raise ScorecardError(f"artifact path does not exist: {root}")
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.suffix.lower() in {".json", ".log"}:
            yield path


def parse_runtime_summary_line(line: str) -> tuple[JsonObject | None, bool]:
    if RUNTIME_SUMMARY_PREFIX in line:
        payload_text = line.split(RUNTIME_SUMMARY_PREFIX, 1)[1].strip()
        saw_prefix = True
    else:
        payload_text = line.strip()
        saw_prefix = False
    if not payload_text:
        return None, saw_prefix
    try:
        parsed = json.loads(html.unescape(payload_text))
    except json.JSONDecodeError:
        return None, saw_prefix
    if isinstance(parsed, dict) and (parsed.get("type") == "runtime-summary" or isinstance(parsed.get("rooms"), list)):
        return parsed, False
    return None, False


def parse_runtime_log(path: Path) -> tuple[list[JsonObject], int]:
    summaries: list[JsonObject] = []
    malformed = 0
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                summary, was_malformed = parse_runtime_summary_line(line)
                if was_malformed:
                    malformed += 1
                if summary is not None:
                    summaries.append(summary)
    except OSError as error:
        raise ScorecardError(f"could not read {path}: {error}") from error
    summaries.sort(key=lambda item: number_value(item.get("tick")) or 0.0)
    return summaries, malformed


def artifact_kind(path: Path, payload: Any | None, runtime_summary_count: int = 0) -> str:
    name = path.name.lower()
    raw_type = payload.get("type") if isinstance(payload, dict) else None
    type_text = raw_type.lower() if isinstance(raw_type, str) else ""
    if runtime_summary_count:
        return "runtime_summary_console"
    if isinstance(payload, dict) and (payload.get("type") == "runtime-summary" or isinstance(payload.get("rooms"), list)):
        return "runtime_summary"
    if "postdeploy-summary" in name or "postdeploy" in type_text:
        return "postdeploy_summary"
    if "policy-advantage" in name or "policyadvantage" in normalized_key(type_text):
        return "policy_advantage"
    if "training-ledger" in name or "training" in name or "training" in type_text:
        return "training_ledger"
    if "conclusion-registry" in name:
        return "conclusion_registry"
    if "shadow" in type_text or "shadow" in name:
        return "shadow_eval"
    if "gate" in name or "gate" in type_text:
        return "evaluation_gate"
    return "json"


def collect_referenced_paths(payload: Any, base_dir: Path, repo_root: Path) -> list[Path]:
    paths: list[Path] = []

    def visit(value: Any, parent_key: str = "") -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                visit(item, str(key))
            return
        if isinstance(value, list):
            for item in value:
                visit(item, parent_key)
            return
        if not isinstance(value, str) or not value:
            return
        key = normalized_key(parent_key)
        if "path" not in key and "artifact" not in key and "file" not in key:
            return
        if any(marker in value.lower() for marker in ("token", "secret", "password", "steam_key")):
            return
        candidate = Path(value).expanduser()
        candidates = [candidate] if candidate.is_absolute() else [base_dir / candidate, repo_root / candidate]
        for raw_path in candidates:
            try:
                resolved = raw_path.resolve()
            except OSError:
                continue
            if resolved.exists() and resolved.suffix.lower() in {".json", ".log"}:
                try:
                    resolved.relative_to(base_dir)
                    paths.append(resolved)
                    break
                except ValueError:
                    try:
                        resolved.relative_to(repo_root)
                        paths.append(resolved)
                        break
                    except ValueError:
                        continue

    visit(payload)
    unique: list[Path] = []
    seen: set[Path] = set()
    for path in paths:
        if path not in seen:
            unique.append(path)
            seen.add(path)
    return unique


def resolve_initial_path(path: Path, repo_root: Path) -> Path:
    expanded = path.expanduser()
    resolved = expanded if expanded.is_absolute() else repo_root / expanded
    return resolved.resolve()


def collect_artifact_bundle(
    root_path: Path,
    *,
    role: str,
    repo_root: Path,
    explicit_id: str | None = None,
    explicit_commit: str | None = None,
) -> JsonObject:
    root = resolve_initial_path(root_path, repo_root)
    if not root.exists():
        raise ScorecardError(f"{role} artifact path does not exist: {root_path}")

    queue = list(iter_artifact_files(root))
    seen_files: set[Path] = set()
    accumulator = MetricAccumulator()
    artifacts: list[JsonObject] = []
    identifiers: list[str] = []
    commits: list[str] = []

    while queue:
        path = queue.pop(0).resolve()
        if path in seen_files:
            continue
        if len(seen_files) >= MAX_REFERENCED_ARTIFACTS:
            raise ScorecardError(f"too many referenced artifacts for {role}; limit is {MAX_REFERENCED_ARTIFACTS}")
        seen_files.add(path)
        source = display_path(path, repo_root)
        payload: Any | None = None
        runtime_summary_count = 0
        malformed_runtime_summary_count = 0

        if path.suffix.lower() == ".log":
            summaries, malformed_runtime_summary_count = parse_runtime_log(path)
            runtime_summary_count = len(summaries)
            for summary in summaries:
                ingest_runtime_summary(accumulator, summary, source)
        else:
            payload = load_json(path)
            if isinstance(payload, dict):
                if payload.get("type") == "runtime-summary" or isinstance(payload.get("rooms"), list):
                    runtime_summary_count = 1
                    ingest_runtime_summary(accumulator, payload, source)
                ingest_json_artifact(accumulator, payload, path, source)
                identifiers.extend(extract_identifiers(payload, role))
                commits.extend(extract_commits(payload, role))
                for referenced in collect_referenced_paths(payload, path.parent, repo_root):
                    if referenced not in seen_files and referenced not in queue:
                        queue.append(referenced)

        artifacts.append(
            {
                "kind": artifact_kind(path, payload, runtime_summary_count),
                "path": source,
                "runtimeSummaryCount": runtime_summary_count,
                "malformedRuntimeSummaryCount": malformed_runtime_summary_count,
            }
        )

    metrics = accumulator.summarize()
    resolved_id = explicit_id or first_text(identifiers) or default_bundle_id(root, metrics)
    resolved_commit = explicit_commit or first_text(commits)
    return {
        "id": resolved_id,
        "commit": resolved_commit,
        "artifacts": artifacts,
        "metrics": metrics,
    }


def first_text(values: Sequence[str]) -> str | None:
    for value in values:
        if value:
            return value
    return None


def default_bundle_id(root: Path, metrics: JsonObject) -> str:
    stem = root.stem if root.is_file() else root.name
    digest = canonical_hash({"root": str(root), "metrics": metrics})[:10]
    return f"{stem}-{digest}"


def extract_identifiers(payload: JsonObject, role: str) -> list[str]:
    keys = (
        (f"{role}Id",),
        (role, "id"),
        ("candidateId",),
        ("baselineId",),
        ("candidateStrategyId",),
        ("incumbentStrategyId",),
        ("reportId",),
        ("gateId",),
        ("runId",),
        ("id",),
    )
    values: list[str] = []
    for path in keys:
        found = path_value(payload, path)
        if isinstance(found, str) and found:
            values.append(found)
    return values


def extract_commits(payload: JsonObject, role: str) -> list[str]:
    keys = (
        (role, "commit"),
        (role, "codeCommit"),
        (role, "deployRef"),
        (f"{role}Commit",),
        ("code_commit",),
        ("codeCommit",),
        ("botCommit",),
        ("deployRef",),
        ("headRefOid",),
        ("commit",),
    )
    values: list[str] = []
    for path in keys:
        found = path_value(payload, path)
        if isinstance(found, str) and found:
            values.append(found)
    return values


def ingest_json_artifact(accumulator: MetricAccumulator, payload: JsonObject, path: Path, source: str) -> None:
    kind = artifact_kind(path, payload)
    if kind in {"evaluation_gate", "shadow_eval", "conclusion_registry"}:
        ingest_gate_or_shadow(accumulator, payload, source)
    if kind in {"training_ledger", "policy_advantage"}:
        ingest_training_or_advantage(accumulator, payload, source)
    if kind == "postdeploy_summary":
        ingest_postdeploy(accumulator, payload, source)
    if payload.get("type") == "runtime-kpi-report":
        ingest_runtime_kpi_report(accumulator, payload, source)


def ingest_gate_or_shadow(accumulator: MetricAccumulator, payload: JsonObject, source: str) -> None:
    status = normalized_status(payload)
    if status is not None:
        accumulator.add("gate_pass", 1 if status == "pass" else 0, source, f"gate status {status}")
    if payload.get("ok") is False:
        accumulator.add("gate_pass", 0, source, "ok=false")
    if payload.get("liveEffect") is True or payload.get("officialMmoWrites") is True:
        accumulator.add("gate_pass", 0, source, "unsafe live/write flag")

    for check_key in ("datasetGate", "quality_checks", "shadowEvaluation", "historicalValidation", "rolloutGate"):
        check = payload.get(check_key)
        if isinstance(check, dict):
            check_status = normalized_status(check)
            if check_status is not None:
                accumulator.add("gate_pass", 1 if check_status == "pass" else 0, source, f"{check_key}={check_status}")

    blocking_text = canonical_json(payload.get("blockingReasons", payload.get("reasons", []))).lower()
    if "room_dead" in blocking_text or "room dead" in blocking_text:
        accumulator.add("room_dead_count", 1, source, "blocking reason references room_dead")
    if "spawn_collapse" in blocking_text or "no_owned_spawn" in blocking_text or "no owned spawn" in blocking_text:
        accumulator.add("spawn_collapse_count", 1, source, "blocking reason references spawn collapse")

    ranking_diff = find_first_number_by_keys(payload, ("rankingDiffCount", "changedTopCount"))
    if ranking_diff is not None:
        accumulator.add("stale_candidate", 0 if ranking_diff > 0 else 1, source, "shadow ranking movement")


def normalized_status(payload: JsonObject) -> str | None:
    for key in ("gateStatus", "status", "decision", "result"):
        value = payload.get(key)
        if not isinstance(value, str):
            continue
        normalized = value.lower().replace("_", "-")
        if normalized in {"pass", "passed", "ok", "rollout-approved", "approved"}:
            return "pass"
        if normalized in {"fail", "failed", "error", "rollout-rejected", "rejected", "blocked"}:
            return "fail"
    return None


def ingest_training_or_advantage(accumulator: MetricAccumulator, payload: JsonObject, source: str) -> None:
    if preflight_only_compute_payload(payload):
        return

    for result in as_list(payload.get("variantResults")):
        if not isinstance(result, dict):
            continue
        metrics = as_dict(result.get("metrics"))
        territory = as_dict(metrics.get("territory"))
        resources = as_dict(metrics.get("resources"))
        kills = as_dict(metrics.get("kills"))
        accumulator.add("owned_room_count", territory.get("ownedRoomCount"), source, "training variant owned rooms")
        accumulator.add("controller_level_sum", territory.get("rclDelta"), source, "training variant RCL delta")
        accumulator.add("harvested_energy", resources.get("collectedEnergy"), source, "training collected energy")
        accumulator.add("stored_energy", resources.get("storedEnergyDelta"), source, "training stored energy delta")
        hostile_kills = number_value(kills.get("hostileKills")) or 0.0
        own_losses = number_value(kills.get("ownLosses")) or 0.0
        accumulator.add("combat_score", hostile_kills - own_losses, source, "training combat score")

    ranking_diff = find_first_number_by_keys(payload, ("rankingDiffCount", "changedTopCount"))
    if ranking_diff is not None:
        accumulator.add("stale_candidate", 0 if ranking_diff > 0 else 1, source, "training ranking movement")

    advantage_values = {
        "territory": find_first_number_by_keys(payload, ("advantageTerritory", "territoryAdvantage", "advantage_territory")),
        "resources": find_first_number_by_keys(payload, ("advantageResources", "resourcesAdvantage", "advantage_resources")),
        "kills": find_first_number_by_keys(payload, ("advantageKills", "killsAdvantage", "advantage_kills")),
    }
    if advantage_values["territory"] is not None:
        accumulator.add("owned_room_count", advantage_values["territory"], source, "policy territory advantage")
    if advantage_values["resources"] is not None:
        accumulator.add("productive_energy", advantage_values["resources"], source, "policy resource advantage")
    if advantage_values["kills"] is not None:
        accumulator.add("combat_score", advantage_values["kills"], source, "policy kill advantage")

    ranking = [item for item in as_list(payload.get("ranking")) if isinstance(item, dict)]
    incumbent_ids = {item for item in as_list(payload.get("incumbentStrategyIds")) if isinstance(item, str)}
    if ranking and incumbent_ids:
        best_tuple = reward_tuple_from_ranking_item(ranking[0])
        incumbent = next((item for item in ranking if text_value(item.get("variantId")) in incumbent_ids), None)
        incumbent_tuple = reward_tuple_from_ranking_item(incumbent) if incumbent else []
        if len(best_tuple) >= 4 and len(incumbent_tuple) >= 4:
            accumulator.add("owned_room_count", best_tuple[1] - incumbent_tuple[1], source, "ranking territory advantage")
            accumulator.add("productive_energy", best_tuple[2] - incumbent_tuple[2], source, "ranking resource advantage")
            accumulator.add("combat_score", best_tuple[3] - incumbent_tuple[3], source, "ranking combat advantage")


def reward_tuple_from_ranking_item(item: Any) -> list[float]:
    if not isinstance(item, dict):
        return []
    reward = item.get("reward")
    raw_tuple = reward.get("tuple") if isinstance(reward, dict) else item.get("rewardTuple")
    values: list[float] = []
    for value in as_list(raw_tuple):
        parsed = number_value(value)
        if parsed is None:
            return []
        values.append(parsed)
    return values


def ingest_postdeploy(accumulator: MetricAccumulator, payload: JsonObject, source: str) -> None:
    status = normalized_status(payload)
    if status is not None:
        accumulator.add("gate_pass", 1 if status == "pass" else 0, source, f"postdeploy status {status}")
    if payload.get("ok") is False:
        accumulator.add("gate_pass", 0, source, "postdeploy ok=false")
    reasons_text = canonical_json(payload.get("reasons", [])).lower()
    if "postdeploy_room_dead" in reasons_text or "room_dead" in reasons_text:
        accumulator.add("room_dead_count", 1, source, "postdeploy room_dead")
    if "postdeploy_no_owned_spawn" in reasons_text or "no_owned_spawn" in reasons_text:
        accumulator.add("spawn_collapse_count", 1, source, "postdeploy no owned spawn")

    rooms = as_list(payload.get("room_summaries")) or as_list(payload.get("rooms"))
    if not rooms and any(key in payload for key in ("owned_spawns", "owned_creeps", "spawns", "creeps")):
        rooms = [payload]
    owned_rooms = 0
    alive_rooms = 0
    for room in rooms:
        if not isinstance(room, dict):
            continue
        spawns = first_number(room, (("owned_spawns",), ("ownedSpawnCount",), ("spawns",), ("spawnCount",)))
        creeps = first_number(room, (("owned_creeps",), ("ownedCreeps",), ("ownedCreepCount",), ("creeps",), ("creepCount",)))
        if spawns is not None or creeps is not None:
            owned_rooms += 1
            if (spawns or 0) >= 1 and (creeps or 0) >= 1:
                alive_rooms += 1
    if owned_rooms:
        accumulator.add("owned_room_count", owned_rooms, source, "postdeploy owned rooms")
        accumulator.add("expansion_survival_count", alive_rooms, source, "postdeploy rooms with spawn and creeps")


def ingest_runtime_kpi_report(accumulator: MetricAccumulator, payload: JsonObject, source: str) -> None:
    accumulator.add(
        "owned_room_count",
        first_number(payload, (("territory", "ownedRooms", "latestCount"), ("metrics", "territory", "ownedRooms"))),
        source,
        "runtime KPI owned rooms",
    )
    accumulator.add(
        "controller_progress",
        first_number(payload, (("territory", "controllers", "progress", "latestTotal"),)),
        source,
        "runtime KPI controller progress",
    )
    resources_score = first_number(
        payload,
        (
            ("metrics", "resources", "score"),
            ("resources", "totals", "latest", "storedEnergy"),
            ("resources", "eventDeltas", "harvestedEnergy"),
        ),
    )
    accumulator.add("stored_energy", resources_score, source, "runtime KPI resources")
    combat_score = first_number(payload, (("metrics", "kills", "score"), ("combat", "eventDeltas", "creepDestroyedCount")))
    accumulator.add("combat_score", combat_score, source, "runtime KPI combat")


def ingest_runtime_summary(accumulator: MetricAccumulator, payload: JsonObject, source: str) -> None:
    reliability = as_dict(payload.get("reliability"))
    accumulator.add("loop_exception_count", reliability.get("loopExceptionCount"), source, "runtime reliability")
    accumulator.add("telemetry_silence_ticks", reliability.get("telemetrySilenceTicks"), source, "runtime reliability")
    cpu = as_dict(payload.get("cpu"))
    accumulator.add("cpu_bucket_min", cpu.get("bucket"), source, "runtime CPU bucket")
    accumulator.add("cpu_used_avg", cpu.get("used"), source, "runtime CPU used")

    rooms = [room for room in as_list(payload.get("rooms")) if isinstance(room, dict)]
    if not rooms:
        return

    owned_room_count = 0
    controller_progress = 0.0
    controller_level_sum = 0.0
    expansion_survival = 0
    stored_energy = 0.0
    energy_available = 0.0
    defense_infrastructure = 0.0
    hostile_pressure = 0.0
    room_dead_count = 0.0
    spawn_collapse_count = 0.0

    for room in rooms:
        controller = as_dict(room.get("controller"))
        resources = as_dict(room.get("resources"))
        productive = as_dict(resources.get("productiveEnergy"))
        combat = as_dict(room.get("combat"))
        structures = as_dict(room.get("structures"))
        task_counts = as_dict(room.get("taskCounts"))
        behavior = as_dict(room.get("behavior")) or as_dict(room.get("workerEfficiency"))

        spawn_count = room_spawn_count(room)
        worker_count = first_number(room, (("workerCount",), ("ownedCreepCount",), ("creepCount",), ("ownedCreeps",)))
        is_owned = room_is_owned(room)
        if is_owned:
            owned_room_count += 1
            if spawn_count <= 0 and (worker_count or 0) <= 0:
                room_dead_count += 1
            elif spawn_count <= 0:
                spawn_collapse_count += 1
        if spawn_count >= 1 and (worker_count or 0) >= 1:
            expansion_survival += 1

        controller_progress += number_value(controller.get("progress")) or 0.0
        controller_level_sum += number_value(controller.get("level")) or 0.0
        stored_energy += number_value(resources.get("storedEnergy")) or 0.0
        energy_available += (
            number_value(room.get("energyAvailable"))
            or number_value(path_value(room, ("energy", "available")))
            or number_value(resources.get("energyAvailable"))
            or 0.0
        )
        defense_infrastructure += (
            number_value(structures.get("tower"))
            or number_value(structures.get("towers"))
            or number_value(structures.get("STRUCTURE_TOWER"))
            or 0.0
        )
        defense_infrastructure += (
            number_value(structures.get("rampart"))
            or number_value(structures.get("ramparts"))
            or number_value(structures.get("STRUCTURE_RAMPART"))
            or 0.0
        )
        hostile_pressure = max(hostile_pressure, number_value(combat.get("hostileCreepCount")) or 0.0)

        resource_events = as_dict(resources.get("events"))
        accumulator.add("harvested_energy", resource_events.get("harvestedEnergy"), source, f"{room_name(room)} harvest")
        accumulator.add(
            "productive_energy",
            productive_energy_value(productive, task_counts),
            source,
            f"{room_name(room)} productive energy",
        )
        accumulator.add("build_progress", productive.get("builtProgress"), source, f"{room_name(room)} build progress")
        accumulator.add(
            "low_load_return_count",
            first_number(
                behavior,
                (
                    ("avoidableLowLoadReturnCount",),
                    ("lowLoadReturnCount",),
                    ("low_load_return_count",),
                ),
            ),
            source,
            f"{room_name(room)} low-load returns",
        )
        return_factor = first_number(behavior, (("returnLoadFactor",), ("loadFactor",)))
        if return_factor is None:
            carried = first_number(behavior, (("lastReturnEnergy",), ("returnEnergy",)))
            capacity = first_number(behavior, (("returnCapacity",), ("carryCapacity",)))
            if carried is not None and capacity is not None and capacity > 0:
                return_factor = carried / capacity
        accumulator.add("return_load_factor", return_factor, source, f"{room_name(room)} return load factor")

        combat_events = as_dict(combat.get("events"))
        hostile_kills = (
            number_value(combat_events.get("hostileCreepDestroyedCount"))
            or number_value(combat_events.get("hostileKills"))
            or number_value(combat_events.get("creepDestroyedCount"))
            or 0.0
        )
        structure_kills = (
            number_value(combat_events.get("hostileStructureDestroyedCount"))
            or number_value(combat_events.get("objectDestroyedCount"))
            or 0.0
        )
        own_losses = (
            number_value(combat_events.get("ownCreepDestroyedCount"))
            or number_value(combat_events.get("ownLosses"))
            or number_value(combat_events.get("ownStructureDestroyedCount"))
            or 0.0
        )
        if hostile_kills or structure_kills or own_losses:
            accumulator.add("combat_score", hostile_kills + structure_kills - own_losses, source, f"{room_name(room)} combat")

    accumulator.add("owned_room_count", owned_room_count, source, "runtime latest owned rooms")
    accumulator.add("controller_progress", controller_progress, source, "runtime controller progress sum")
    accumulator.add("controller_level_sum", controller_level_sum, source, "runtime controller level sum")
    accumulator.add("expansion_survival_count", expansion_survival, source, "runtime rooms with spawn and creeps")
    accumulator.add("room_dead_count", room_dead_count, source, "runtime rooms with no spawn or worker")
    accumulator.add("spawn_collapse_count", spawn_collapse_count, source, "runtime owned rooms with no spawn")
    accumulator.add("stored_energy", stored_energy, source, "runtime stored energy")
    accumulator.add("energy_surplus", stored_energy + energy_available, source, "runtime stored plus available energy")
    accumulator.add("defense_infrastructure", defense_infrastructure, source, "runtime tower/rampart count")
    accumulator.add("hostile_pressure", hostile_pressure, source, "runtime hostile pressure")


def room_name(room: JsonObject) -> str:
    return text_value(room.get("roomName")) or text_value(room.get("name")) or "room"


def room_is_owned(room: JsonObject) -> bool:
    controller = as_dict(room.get("controller"))
    if controller.get("my") is True:
        return True
    if text_value(controller.get("owner")) in {"me", "self", "owned"}:
        return True
    if room_spawn_count(room) > 0:
        return True
    worker_count = first_number(room, (("workerCount",), ("ownedCreepCount",), ("ownedCreeps",)))
    return worker_count is not None and worker_count > 0


def room_spawn_count(room: JsonObject) -> float:
    spawn_status = room.get("spawnStatus")
    if isinstance(spawn_status, list):
        return float(len(spawn_status))
    structures = as_dict(room.get("structures"))
    for key in ("spawn", "spawns", "STRUCTURE_SPAWN"):
        value = number_value(structures.get(key))
        if value is not None:
            return value
    return (
        first_number(room, (("ownedSpawnCount",), ("spawnCount",), ("owned_spawns",), ("spawns",)))
        or 0.0
    )


def productive_energy_value(productive: JsonObject, task_counts: JsonObject) -> float | None:
    total = 0.0
    seen = False
    for key in (
        "builtProgress",
        "buildProgress",
        "repairedHits",
        "repairProgress",
        "upgradedProgress",
        "upgradeProgress",
        "buildCarriedEnergy",
    ):
        value = number_value(productive.get(key))
        if value is not None:
            total += value
            seen = True
    for key in ("build", "repair", "upgrade"):
        value = number_value(task_counts.get(key))
        if value is not None:
            total += value
            seen = True
    return total if seen else None


def metric_value(bundle: JsonObject, key: str) -> float | None:
    metric = bundle.get("metrics", {}).get(key)
    if not isinstance(metric, dict):
        return None
    return number_value(metric.get("value"))


def metric_evidence(bundle: JsonObject, key: str) -> list[JsonObject]:
    metric = bundle.get("metrics", {}).get(key)
    if not isinstance(metric, dict):
        return []
    return [item for item in as_list(metric.get("evidence")) if isinstance(item, dict)]


def compare_metric(spec: MetricSpec, candidate: JsonObject, baseline: JsonObject) -> JsonObject:
    candidate_value = metric_value(candidate, spec.key)
    baseline_value = metric_value(baseline, spec.key)
    result: JsonObject = {
        "metric": spec.key,
        "label": spec.label,
        "unit": spec.unit,
        "direction": spec.direction,
        "candidate": round_float(candidate_value) if candidate_value is not None else None,
        "baseline": round_float(baseline_value) if baseline_value is not None else None,
        "delta": None,
        "status": STATUS_INCONCLUSIVE,
        "reasons": [],
        "candidateEvidence": metric_evidence(candidate, spec.key),
        "baselineEvidence": metric_evidence(baseline, spec.key),
    }
    reasons: list[str] = result["reasons"]
    if candidate_value is None:
        reasons.append("missing_candidate_metric")
    if baseline_value is None:
        reasons.append("missing_baseline_metric")
    if reasons:
        return result

    delta = candidate_value - baseline_value
    result["delta"] = round_float(delta)
    floor_failed = False
    if spec.maximum is not None and candidate_value > spec.maximum + spec.tolerance:
        floor_failed = True
        reasons.append("candidate_violates_maximum_floor")
    if spec.minimum is not None and candidate_value < spec.minimum - spec.tolerance:
        floor_failed = True
        reasons.append("candidate_violates_minimum_floor")
    if floor_failed:
        result["status"] = STATUS_REGRESSED
        return result

    if abs(delta) <= spec.tolerance:
        result["status"] = STATUS_NEUTRAL
    elif spec.direction == "higher":
        result["status"] = STATUS_IMPROVED if delta > 0 else STATUS_REGRESSED
    elif spec.direction == "lower":
        result["status"] = STATUS_IMPROVED if delta < 0 else STATUS_REGRESSED
    else:
        raise ScorecardError(f"unknown metric direction: {spec.direction}")
    return result


def compare_dimension(spec: DimensionSpec, candidate: JsonObject, baseline: JsonObject) -> JsonObject:
    metrics = [compare_metric(METRIC_SPECS[key], candidate, baseline) for key in spec.metric_keys]
    comparable = [metric for metric in metrics if metric["status"] != STATUS_INCONCLUSIVE]
    regressed = [metric for metric in comparable if metric["status"] == STATUS_REGRESSED]
    improved = [metric for metric in comparable if metric["status"] == STATUS_IMPROVED]

    if regressed:
        status = STATUS_REGRESSED
    elif improved:
        status = STATUS_IMPROVED
    elif comparable:
        status = STATUS_NEUTRAL
    elif spec.missing_behavior == "not_applicable" and not combat_is_applicable(candidate, baseline):
        status = STATUS_NEUTRAL
    else:
        status = STATUS_INCONCLUSIVE

    missing_evidence = [
        metric["metric"]
        for metric in metrics
        if metric["status"] == STATUS_INCONCLUSIVE
        and not (spec.missing_behavior == "not_applicable" and not combat_is_applicable(candidate, baseline))
    ]
    evidence: list[JsonObject] = []
    for metric in metrics:
        if metric["status"] == STATUS_INCONCLUSIVE:
            continue
        evidence.append(
            {
                "metric": metric["metric"],
                "status": metric["status"],
                "candidate": metric["candidate"],
                "baseline": metric["baseline"],
                "delta": metric["delta"],
                "reason": "; ".join(metric["reasons"]) if metric["reasons"] else "candidate compared against baseline",
            }
        )

    return {
        "label": spec.label,
        "status": status,
        "safety": spec.safety,
        "metrics": metrics,
        "evidence": evidence,
        "missingEvidence": missing_evidence,
    }


def combat_is_applicable(candidate: JsonObject, baseline: JsonObject) -> bool:
    for bundle in (candidate, baseline):
        for key in ("combat_score", "hostile_pressure"):
            value = metric_value(bundle, key)
            if value is not None and abs(value) > EPSILON:
                return True
    return False


def build_overall_gate(dimensions: JsonObject) -> JsonObject:
    safety_regressions = [
        key for key, value in dimensions.items() if value["safety"] and value["status"] == STATUS_REGRESSED
    ]
    non_safety_regressions = [
        key for key, value in dimensions.items() if not value["safety"] and value["status"] == STATUS_REGRESSED
    ]
    inconclusive_dimensions = [
        key for key, value in dimensions.items() if value["status"] == STATUS_INCONCLUSIVE
    ]
    improved_non_safety = [
        key for key, value in dimensions.items() if not value["safety"] and value["status"] == STATUS_IMPROVED
    ]

    required_actions: list[str] = []
    if safety_regressions:
        required_actions.append("Reject candidate until safety/reliability regressions are fixed and re-evaluated.")
    if non_safety_regressions:
        required_actions.append("Reject candidate under the monotonic gate until gameplay regressions are removed.")
    if inconclusive_dimensions:
        required_actions.append("Collect missing evidence for inconclusive scorecard dimensions before promotion.")
    if not improved_non_safety:
        required_actions.append("Provide at least one non-safety dimension improvement versus the named baseline.")

    if safety_regressions or non_safety_regressions:
        status = GATE_FAIL
        rationale = "candidate regressed on at least one scorecard dimension"
    elif inconclusive_dimensions:
        status = GATE_INCONCLUSIVE
        rationale = "candidate lacks enough evidence for a complete monotonic comparison"
    elif not improved_non_safety:
        status = GATE_FAIL
        rationale = "candidate did not improve any non-safety dimension"
    else:
        status = GATE_PASS
        rationale = "candidate has no regressions and improves at least one non-safety dimension"

    return {
        "status": status,
        "rationale": rationale,
        "monotonic": {
            "noSafetyRegression": not safety_regressions,
            "noDimensionRegression": not safety_regressions and not non_safety_regressions,
            "improvedNonSafetyDimension": bool(improved_non_safety),
        },
        "safetyRegressions": safety_regressions,
        "nonSafetyRegressions": non_safety_regressions,
        "improvedNonSafetyDimensions": improved_non_safety,
        "inconclusiveDimensions": inconclusive_dimensions,
        "requiredActions": required_actions,
    }


def build_required_actions(dimensions: JsonObject, overall_gate: JsonObject) -> list[str]:
    actions = list(overall_gate.get("requiredActions", []))
    for key, dimension in dimensions.items():
        missing = dimension.get("missingEvidence", [])
        if missing:
            actions.append(f"Add evidence for {key}: {', '.join(missing)}.")
        if dimension.get("status") == STATUS_REGRESSED:
            actions.append(f"Fix or explain {key} regression before candidate promotion.")
    if not actions:
        actions.append("Candidate is eligible for the next review/promote step under this offline scorecard.")
    return actions


def build_scorecard(
    *,
    candidate_path: Path,
    baseline_path: Path,
    repo_root: Path,
    run_id: str | None = None,
    timestamp: str | None = None,
    candidate_id: str | None = None,
    baseline_id: str | None = None,
    candidate_commit: str | None = None,
    baseline_commit: str | None = None,
) -> JsonObject:
    created = timestamp or utc_now_iso()
    candidate = collect_artifact_bundle(
        candidate_path,
        role="candidate",
        repo_root=repo_root,
        explicit_id=candidate_id,
        explicit_commit=candidate_commit,
    )
    baseline = collect_artifact_bundle(
        baseline_path,
        role="baseline",
        repo_root=repo_root,
        explicit_id=baseline_id,
        explicit_commit=baseline_commit,
    )
    resolved_run_id = run_id or default_scorecard_run_id(created, candidate, baseline)
    dimensions = {
        key: compare_dimension(spec, candidate, baseline)
        for key, spec in DIMENSION_SPECS.items()
    }
    overall_gate = build_overall_gate(dimensions)
    return {
        "type": REPORT_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "runId": resolved_run_id,
        "timestamp": created,
        "candidate": public_bundle(candidate),
        "baseline": public_bundle(baseline),
        "dimensions": dimensions,
        "overallGate": overall_gate,
        "requiredActions": build_required_actions(dimensions, overall_gate),
    }


def public_bundle(bundle: JsonObject) -> JsonObject:
    return {
        "id": bundle.get("id"),
        "commit": bundle.get("commit"),
        "artifacts": bundle.get("artifacts", []),
    }


def default_scorecard_run_id(created: str, candidate: JsonObject, baseline: JsonObject) -> str:
    digest = canonical_hash(
        {
            "baseline": baseline.get("id"),
            "candidate": candidate.get("id"),
            "created": created,
            "schemaVersion": SCHEMA_VERSION,
        }
    )[:12]
    return f"rl-scorecard-{digest}"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True, type=Path, help="Candidate artifact file or directory.")
    parser.add_argument("--baseline", required=True, type=Path, help="Baseline artifact file or directory.")
    parser.add_argument("--output", type=Path, help="Optional scorecard JSON output path.")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR, help=f"Default output root: {DEFAULT_OUT_DIR}.")
    parser.add_argument("--run-id", help="Optional scorecard run id.")
    parser.add_argument("--timestamp", help="Optional UTC timestamp for reproducible tests.")
    parser.add_argument("--candidate-id", help="Override candidate id.")
    parser.add_argument("--baseline-id", help="Override baseline id.")
    parser.add_argument("--candidate-commit", help="Override candidate commit.")
    parser.add_argument("--baseline-commit", help="Override baseline commit.")
    parser.add_argument("--repo-root", type=Path, default=Path.cwd(), help="Repository root for relative paths.")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    args = parse_args(argv)
    repo_root = args.repo_root.expanduser().resolve()
    try:
        scorecard = build_scorecard(
            candidate_path=args.candidate,
            baseline_path=args.baseline,
            repo_root=repo_root,
            run_id=args.run_id,
            timestamp=args.timestamp,
            candidate_id=args.candidate_id,
            baseline_id=args.baseline_id,
            candidate_commit=args.candidate_commit,
            baseline_commit=args.baseline_commit,
        )
        output = args.output
        if output is None:
            output = args.out_dir / f"{scorecard['runId']}.json"
        output = output.expanduser()
        if not output.is_absolute():
            output = repo_root / output
        write_json_atomic(output, scorecard)
        stdout.write(canonical_json({"output": display_path(output, repo_root), "overallGate": scorecard["overallGate"]}))
        return 0
    except ScorecardError as error:
        stderr.write(f"error: {error}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
