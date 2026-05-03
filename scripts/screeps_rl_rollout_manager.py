#!/usr/bin/env python3
"""KPI-gated rollout, rollback, and feedback records for the Screeps RL flywheel."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TextIO


SCHEMA_VERSION = 1
CONTRACT_VERSION = 1
CONTRACT_TYPE = "screeps-rl-rollout-gate-contract"
COMPARISON_TYPE = "screeps-rl-post-rollout-kpi-comparison"
DECISION_TYPE = "screeps-rl-rollout-decision"
ROLLBACK_TYPE = "screeps-rl-rollback-check"
DEFAULT_OBSERVATION_WINDOW_HOURS = 8.0
DEFAULT_MIN_OBSERVATION_SAMPLES = 8
DEFAULT_SECONDS_PER_TICK = 3.0
METRIC_ORDER = ("reliability", "territory", "resources", "kills")
EPSILON = 1e-9

JsonObject = dict[str, Any]


class RolloutManagerError(ValueError):
    """Raised when rollout manager input is missing or structurally invalid."""


@dataclass(frozen=True)
class MetricSpec:
    key: str
    label: str
    unit: str
    source: str
    max_degradation_absolute: float | None = None
    max_degradation_percent: float | None = None
    minimum_post_value: float | None = None

    def allowed_degradation(self, baseline: float) -> float:
        limits: list[float] = []
        if self.max_degradation_absolute is not None:
            limits.append(self.max_degradation_absolute)
        if self.max_degradation_percent is not None:
            limits.append(abs(baseline) * self.max_degradation_percent / 100.0)
        return min(limits) if limits else 0.0

    def to_json(self) -> JsonObject:
        payload: JsonObject = {
            "direction": "higher_is_better",
            "label": self.label,
            "required": True,
            "source": self.source,
            "unit": self.unit,
        }
        if self.max_degradation_absolute is not None:
            payload["maxDegradationAbsolute"] = round_float(self.max_degradation_absolute)
        if self.max_degradation_percent is not None:
            payload["maxDegradationPercent"] = round_float(self.max_degradation_percent)
        if self.minimum_post_value is not None:
            payload["minimumPostValue"] = round_float(self.minimum_post_value)
        return payload


METRIC_SPECS: dict[str, MetricSpec] = {
    "territory": MetricSpec(
        key="territory",
        label="owned room count",
        unit="rooms",
        source="territory.ownedRooms.latestCount or metrics.territory.ownedRooms",
        max_degradation_absolute=0.0,
    ),
    "resources": MetricSpec(
        key="resources",
        label="resource score",
        unit="energy-equivalent points",
        source=(
            "metrics.resources.score or resources latest stored/carried energy plus "
            "harvested/transferred event throughput"
        ),
        max_degradation_absolute=500.0,
        max_degradation_percent=5.0,
    ),
    "kills": MetricSpec(
        key="kills",
        label="hostile kill score",
        unit="hostile kills minus own losses",
        source="metrics.kills.score or combat event kill counters",
        max_degradation_absolute=1.0,
    ),
    "reliability": MetricSpec(
        key="reliability",
        label="runtime reliability score",
        unit="0..1 score",
        source="metrics.reliability.score or runtime-summary success ratio",
        max_degradation_absolute=0.02,
        minimum_post_value=0.98,
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


def round_float(value: float | int) -> float | int:
    numeric = float(value)
    if math.isfinite(numeric) and numeric.is_integer():
        return int(numeric)
    return round(numeric, 6)


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def number_or_none(value: Any) -> float | None:
    return float(value) if is_number(value) else None


def path_value(raw: Any, path: tuple[str, ...]) -> Any:
    value = raw
    for part in path:
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


def first_number(raw: JsonObject, paths: tuple[tuple[str, ...], ...]) -> float | None:
    for path in paths:
        value = number_or_none(path_value(raw, path))
        if value is not None:
            return value
    return None


def metric_block(raw: JsonObject, key: str) -> Any:
    for container_key in ("metrics", "kpis"):
        container = raw.get(container_key)
        if isinstance(container, dict) and key in container:
            return container[key]
    return raw.get(key)


def block_number(raw: JsonObject, key: str, fields: tuple[str, ...]) -> float | None:
    block = metric_block(raw, key)
    direct = number_or_none(block)
    if direct is not None:
        return direct
    if not isinstance(block, dict):
        return None
    for field in fields:
        value = number_or_none(block.get(field))
        if value is not None:
            return value
    return None


def sum_numeric_fields(raw: Any, fields: tuple[str, ...]) -> tuple[float, bool]:
    if not isinstance(raw, dict):
        return 0.0, False
    total = 0.0
    seen = False
    for field in fields:
        value = number_or_none(raw.get(field))
        if value is not None:
            total += value
            seen = True
    return total, seen


def extract_territory(raw: JsonObject) -> float | None:
    explicit = block_number(raw, "territory", ("score", "ownedRooms", "ownedRoomCount", "latestCount", "roomCount"))
    if explicit is not None:
        return explicit
    return first_number(
        raw,
        (
            ("territory", "ownedRooms", "latestCount"),
            ("territory", "latestCount"),
            ("kpiSummary", "territory"),
        ),
    )


def extract_resources(raw: JsonObject) -> float | None:
    explicit = block_number(raw, "resources", ("score", "resourceScore", "energy", "storedEnergy"))
    if explicit is not None:
        return explicit

    latest = path_value(raw, ("resources", "totals", "latest"))
    latest_total, latest_seen = sum_numeric_fields(latest, ("storedEnergy", "workerCarriedEnergy"))
    events = path_value(raw, ("resources", "eventDeltas"))
    event_total, event_seen = sum_numeric_fields(events, ("harvestedEnergy", "transferredEnergy", "collectedEnergy"))
    if latest_seen or event_seen:
        return latest_total + event_total

    return first_number(
        raw,
        (
            ("kpiSummary", "resources"),
            ("resources", "totals", "latest", "storedEnergy"),
        ),
    )


def extract_kills(raw: JsonObject) -> float | None:
    explicit = block_number(raw, "kills", ("score", "hostileKills", "hostileCreepDestroyedCount", "kills"))
    if explicit is not None:
        return explicit

    combat = raw.get("combat")
    events = path_value(raw, ("combat", "eventDeltas"))
    if not isinstance(events, dict) and isinstance(combat, dict):
        events = combat.get("events")

    hostile = first_event_number(
        events,
        ("hostileCreepDestroyedCount", "hostileKills", "creepDestroyedCount"),
    )
    structures = first_event_number(events, ("hostileStructureDestroyedCount", "objectDestroyedCount"))
    own_losses = first_event_number(events, ("ownCreepDestroyedCount", "ownLosses", "ownStructureDestroyedCount"))
    if hostile is not None or structures is not None or own_losses is not None:
        return (hostile or 0.0) + (structures or 0.0) - (own_losses or 0.0)

    return first_number(raw, (("kpiSummary", "kills"),))


def first_event_number(events: Any, fields: tuple[str, ...]) -> float | None:
    if not isinstance(events, dict):
        return None
    for field in fields:
        value = number_or_none(events.get(field))
        if value is not None:
            return value
    return None


def extract_reliability(raw: JsonObject) -> float | None:
    explicit = block_number(raw, "reliability", ("score", "okRate", "successRate", "runtimeSuccessRate"))
    if explicit is not None:
        return explicit

    input_block = raw.get("input")
    if isinstance(input_block, dict):
        good = number_or_none(input_block.get("runtimeSummaryCount"))
        malformed = number_or_none(input_block.get("malformedRuntimeSummaryCount"))
        if good is not None and malformed is not None and good + malformed > 0:
            return good / (good + malformed)

    sample_count = sample_count_from(raw)
    error_count = first_number(
        raw,
        (
            ("reliability", "loopErrorCount"),
            ("reliability", "runtimeErrorCount"),
            ("runtime", "loopErrorCount"),
            ("alerts", "criticalCount"),
        ),
    )
    if sample_count is not None and error_count is not None and sample_count > 0:
        return max(0.0, 1.0 - (error_count / sample_count))
    return None


def extract_metrics(raw: JsonObject) -> dict[str, float | None]:
    return {
        "territory": extract_territory(raw),
        "resources": extract_resources(raw),
        "kills": extract_kills(raw),
        "reliability": extract_reliability(raw),
    }


def parse_iso_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    normalized = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def duration_hours_from_timestamps(start: Any, end: Any) -> float | None:
    started_at = parse_iso_datetime(start)
    ended_at = parse_iso_datetime(end)
    if started_at is None or ended_at is None:
        return None
    seconds = (ended_at - started_at).total_seconds()
    return seconds / 3600.0 if seconds >= 0 else None


def duration_hours_from_ticks(first_tick: Any, latest_tick: Any) -> float | None:
    first = number_or_none(first_tick)
    latest = number_or_none(latest_tick)
    if first is None or latest is None or latest < first:
        return None
    return (latest - first) * DEFAULT_SECONDS_PER_TICK / 3600.0


def sample_count_from(raw: JsonObject) -> float | None:
    value = first_number(
        raw,
        (
            ("window", "sampleCount"),
            ("window", "samples"),
            ("sampleCount",),
            ("samples",),
            ("input", "runtimeSummaryCount"),
            ("source", "runtimeSummaryLines"),
        ),
    )
    if value is not None:
        return value
    samples = raw.get("samples")
    if isinstance(samples, list):
        return float(len(samples))
    return None


def normalize_window(raw: JsonObject, source_path: str | None = None) -> JsonObject:
    window = raw.get("window") if isinstance(raw.get("window"), dict) else {}

    duration_hours = first_number(
        raw,
        (
            ("window", "durationHours"),
            ("window", "hours"),
            ("durationHours",),
            ("hours",),
        ),
    )
    if duration_hours is None:
        duration_hours = duration_hours_from_timestamps(
            path_value(raw, ("window", "startedAt")) or raw.get("startedAt"),
            path_value(raw, ("window", "endedAt")) or raw.get("endedAt"),
        )
    if duration_hours is None:
        duration_hours = duration_hours_from_timestamps(
            path_value(raw, ("window", "firstAt")),
            path_value(raw, ("window", "latestAt")),
        )
    if duration_hours is None:
        duration_hours = duration_hours_from_ticks(
            path_value(raw, ("window", "firstTick")),
            path_value(raw, ("window", "latestTick")),
        )

    return {
        "durationHours": round_float(duration_hours) if duration_hours is not None else None,
        "endedAt": window.get("endedAt") or raw.get("endedAt"),
        "firstTick": window.get("firstTick"),
        "latestTick": window.get("latestTick"),
        "sampleCount": round_float(sample_count_from(raw)) if sample_count_from(raw) is not None else None,
        "sourcePath": source_path,
        "startedAt": window.get("startedAt") or raw.get("startedAt"),
    }


def normalize_kpi_window(raw: JsonObject, source_path: str | None = None) -> JsonObject:
    if not isinstance(raw, dict):
        raise RolloutManagerError("KPI input must be a JSON object")
    return {
        "metrics": {key: round_float(value) if value is not None else None for key, value in extract_metrics(raw).items()},
        "rawType": raw.get("type"),
        "window": normalize_window(raw, source_path),
    }


def build_gate_contract() -> JsonObject:
    return {
        "type": CONTRACT_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "contractVersion": CONTRACT_VERSION,
        "observationWindow": {
            "hours": DEFAULT_OBSERVATION_WINDOW_HOURS,
            "minimumSamples": DEFAULT_MIN_OBSERVATION_SAMPLES,
            "sampleContract": (
                "pre and post rollout KPI windows must each cover at least 8 hours and "
                "8 runtime-summary samples before a dry-run rollout can pass"
            ),
        },
        "metrics": {key: METRIC_SPECS[key].to_json() for key in METRIC_ORDER},
        "rolloutGate": {
            "decision": "rollout_approved only when every required KPI passes and both windows satisfy the observation contract",
            "defaultDecision": "rollout_rejected",
            "dryRunOnly": True,
        },
        "rollbackTrigger": rollback_trigger_spec(),
        "feedbackIngestion": {
            "postWindowRequired": True,
            "record": "persist the dry-run decision, rollback checks, and post-rollout comparison as RL dataset source metadata",
            "nextDatasetTag": "rl-rollout-feedback",
        },
    }


def rollback_trigger_spec() -> JsonObject:
    return {
        "autoRevert": True,
        "firesWhen": (
            "within the 8 hour observation window, any contracted KPI has a measured "
            "degradation greater than its threshold or reliability falls below 0.98"
        ),
        "action": (
            "restore the previous approved deploy reference, stop the candidate rollout, "
            "and emit the rollback check record for feedback ingestion"
        ),
        "scope": "high-level strategy rollout only; this helper does not perform live deploy or git operations",
    }


def compare_metric(pre_value: Any, post_value: Any, spec: MetricSpec) -> JsonObject:
    pre = number_or_none(pre_value)
    post = number_or_none(post_value)
    result: JsonObject = {
        "allowedDegradation": None,
        "delta": None,
        "degradation": None,
        "metric": spec.key,
        "post": post_value,
        "pre": pre_value,
        "reasons": [],
        "status": "pass",
        "threshold": spec.to_json(),
        "triggered": False,
    }
    reasons: list[str] = result["reasons"]
    if pre is None:
        reasons.append("missing_pre_metric")
    if post is None:
        reasons.append("missing_post_metric")
    if reasons:
        result["status"] = "fail"
        return result

    delta = post - pre
    degradation = max(0.0, pre - post)
    allowed = spec.allowed_degradation(pre)
    result["pre"] = round_float(pre)
    result["post"] = round_float(post)
    result["delta"] = round_float(delta)
    result["degradation"] = round_float(degradation)
    result["allowedDegradation"] = round_float(allowed)

    if degradation > allowed + EPSILON:
        reasons.append("degradation_exceeds_threshold")
        result["triggered"] = True
    if spec.minimum_post_value is not None and post < spec.minimum_post_value - EPSILON:
        reasons.append("below_minimum_post_value")
        result["triggered"] = True

    if reasons:
        result["status"] = "fail"
    return result


def evaluate_observation_contract(
    pre_window: JsonObject,
    post_window: JsonObject,
    *,
    require_complete_window: bool,
) -> JsonObject:
    checks: list[JsonObject] = []
    if not require_complete_window:
        return {
            "checks": checks,
            "requiredHours": DEFAULT_OBSERVATION_WINDOW_HOURS,
            "requiredSamples": DEFAULT_MIN_OBSERVATION_SAMPLES,
            "status": "not_required_for_mode",
        }

    for label, window in (("pre", pre_window), ("post", post_window)):
        duration = number_or_none(window.get("durationHours"))
        if duration is None:
            checks.append({"label": label, "reason": "missing_duration_hours", "status": "fail"})
        elif duration + EPSILON < DEFAULT_OBSERVATION_WINDOW_HOURS:
            checks.append(
                {
                    "actualHours": round_float(duration),
                    "label": label,
                    "reason": "duration_below_observation_window",
                    "requiredHours": DEFAULT_OBSERVATION_WINDOW_HOURS,
                    "status": "fail",
                }
            )
        else:
            checks.append({"actualHours": round_float(duration), "label": label, "status": "pass"})

        sample_count = number_or_none(window.get("sampleCount"))
        if sample_count is None:
            checks.append({"label": label, "reason": "missing_sample_count", "status": "fail"})
        elif sample_count + EPSILON < DEFAULT_MIN_OBSERVATION_SAMPLES:
            checks.append(
                {
                    "actualSamples": round_float(sample_count),
                    "label": label,
                    "reason": "samples_below_minimum",
                    "requiredSamples": DEFAULT_MIN_OBSERVATION_SAMPLES,
                    "status": "fail",
                }
            )
        else:
            checks.append({"actualSamples": round_float(sample_count), "label": label, "status": "pass"})

    return {
        "checks": checks,
        "requiredHours": DEFAULT_OBSERVATION_WINDOW_HOURS,
        "requiredSamples": DEFAULT_MIN_OBSERVATION_SAMPLES,
        "status": "fail" if any(check["status"] == "fail" for check in checks) else "pass",
    }


def build_kpi_comparison(
    pre_raw: JsonObject,
    post_raw: JsonObject,
    *,
    created_at: str | None = None,
    pre_source: str | None = None,
    post_source: str | None = None,
    require_complete_window: bool = True,
) -> JsonObject:
    pre = normalize_kpi_window(pre_raw, pre_source)
    post = normalize_kpi_window(post_raw, post_source)
    metrics = {
        key: compare_metric(pre["metrics"].get(key), post["metrics"].get(key), METRIC_SPECS[key])
        for key in METRIC_ORDER
    }
    observation = evaluate_observation_contract(
        pre["window"],
        post["window"],
        require_complete_window=require_complete_window,
    )
    return {
        "type": COMPARISON_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "contractVersion": CONTRACT_VERSION,
        "createdAt": created_at or utc_now_iso(),
        "gateStatus": "pass"
        if observation["status"] in ("pass", "not_required_for_mode")
        and all(metric["status"] == "pass" for metric in metrics.values())
        else "fail",
        "metrics": metrics,
        "observation": observation,
        "post": post,
        "pre": pre,
    }


def collect_blocking_reasons(comparison: JsonObject) -> list[JsonObject]:
    reasons: list[JsonObject] = []
    for check in comparison["observation"].get("checks", []):
        if check.get("status") == "fail":
            reasons.append({"scope": "observation", **check})
    for key, metric in comparison["metrics"].items():
        if metric["status"] != "pass":
            reasons.append({"metric": key, "reasons": list(metric["reasons"]), "scope": "metric"})
    return reasons


def build_feedback_ingestion(decision: str, candidate_id: str | None, comparison: JsonObject) -> JsonObject:
    ready = decision == "rollout_approved"
    return {
        "candidateId": candidate_id,
        "datasetTag": "rl-rollout-feedback",
        "nextAction": (
            "ingest post-rollout KPI comparison into the next RL dataset window"
            if ready
            else "do not ingest as successful rollout feedback; retain as rejected candidate evidence"
        ),
        "sourceTypes": [comparison["pre"].get("rawType"), comparison["post"].get("rawType")],
        "status": "ready" if ready else "blocked",
    }


def build_dry_run_decision(
    pre_raw: JsonObject,
    post_raw: JsonObject,
    *,
    candidate_id: str | None = None,
    deploy_ref: str | None = None,
    created_at: str | None = None,
    rollout_id: str | None = None,
    pre_source: str | None = None,
    post_source: str | None = None,
) -> JsonObject:
    created = created_at or utc_now_iso()
    comparison = build_kpi_comparison(
        pre_raw,
        post_raw,
        created_at=created,
        pre_source=pre_source,
        post_source=post_source,
        require_complete_window=True,
    )
    passed = comparison["gateStatus"] == "pass"
    decision = "rollout_approved" if passed else "rollout_rejected"
    id_seed = {
        "candidateId": candidate_id,
        "comparison": comparison["metrics"],
        "createdAt": created,
        "deployRef": deploy_ref,
    }
    resolved_rollout_id = rollout_id or f"rl-rollout-{canonical_hash(id_seed)[:12]}"
    return {
        "type": DECISION_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "blockingReasons": collect_blocking_reasons(comparison),
        "candidate": {
            "deployRef": deploy_ref,
            "id": candidate_id,
        },
        "comparison": comparison,
        "createdAt": created,
        "decision": decision,
        "dryRun": True,
        "feedbackIngestion": build_feedback_ingestion(decision, candidate_id, comparison),
        "gateContract": build_gate_contract(),
        "mode": "dry-run",
        "passed": passed,
        "rollbackTrigger": rollback_trigger_spec(),
        "rolloutId": resolved_rollout_id,
    }


def within_observation_window(current_window: JsonObject) -> bool:
    duration = number_or_none(current_window.get("durationHours"))
    return duration is None or duration <= DEFAULT_OBSERVATION_WINDOW_HOURS + EPSILON


def build_rollback_check(
    baseline_raw: JsonObject,
    current_raw: JsonObject,
    *,
    candidate_id: str | None = None,
    previous_deploy_ref: str | None = None,
    current_deploy_ref: str | None = None,
    created_at: str | None = None,
    rollout_id: str | None = None,
    baseline_source: str | None = None,
    current_source: str | None = None,
) -> JsonObject:
    created = created_at or utc_now_iso()
    comparison = build_kpi_comparison(
        baseline_raw,
        current_raw,
        created_at=created,
        pre_source=baseline_source,
        post_source=current_source,
        require_complete_window=False,
    )
    metric_triggers = [
        {
            "allowedDegradation": metric["allowedDegradation"],
            "degradation": metric["degradation"],
            "metric": key,
            "post": metric["post"],
            "pre": metric["pre"],
            "reasons": metric["reasons"],
        }
        for key, metric in comparison["metrics"].items()
        if metric.get("triggered") is True
    ]
    in_window = within_observation_window(comparison["post"]["window"])
    rollback_triggered = bool(metric_triggers and in_window)
    decision = "auto_revert" if rollback_triggered else "continue_observation"
    resolved_rollout_id = rollout_id or f"rl-rollout-{canonical_hash({'candidateId': candidate_id, 'createdAt': created})[:12]}"
    return {
        "type": ROLLBACK_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "candidate": {
            "currentDeployRef": current_deploy_ref,
            "id": candidate_id,
            "previousDeployRef": previous_deploy_ref,
        },
        "comparison": comparison,
        "createdAt": created,
        "currentWithinObservationWindow": in_window,
        "decision": decision,
        "metricTriggers": metric_triggers,
        "rollbackTrigger": rollback_trigger_spec(),
        "rollbackTriggered": rollback_triggered,
        "rolloutId": resolved_rollout_id,
    }


def load_json(path: Path) -> JsonObject:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise RolloutManagerError(f"could not read {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise RolloutManagerError(f"{path} is not valid JSON: {error}") from error
    if not isinstance(parsed, dict):
        raise RolloutManagerError(f"{path} must contain a JSON object")
    return parsed


def write_output(payload: Any, output: Path | None, stdout: TextIO) -> None:
    text = canonical_json(payload)
    if output is None:
        stdout.write(text)
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(text, encoding="utf-8")


def add_common_kpi_args(parser: argparse.ArgumentParser, left_name: str, right_name: str) -> None:
    parser.add_argument(f"--{left_name}", type=Path, required=True, help=f"{left_name} KPI JSON fixture/report")
    parser.add_argument(f"--{right_name}", type=Path, required=True, help=f"{right_name} KPI JSON fixture/report")
    parser.add_argument("--created-at", help="ISO UTC timestamp to record. Defaults to current UTC second.")
    parser.add_argument("--output", type=Path, help="Write JSON output to this path instead of stdout.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Evaluate KPI-gated RL rollout, rollback, and post-rollout comparison records.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    contract = subparsers.add_parser("contract", help="Print the KPI rollout gate contract.")
    contract.add_argument("--output", type=Path, help="Write JSON output to this path instead of stdout.")

    dry_run = subparsers.add_parser("dry-run", help="Evaluate a dry-run rollout decision from pre/post KPI fixtures.")
    add_common_kpi_args(dry_run, "pre", "post")
    dry_run.add_argument("--candidate-id", help="Candidate strategy/model identifier.")
    dry_run.add_argument("--deploy-ref", help="Candidate deploy reference or commit.")
    dry_run.add_argument("--rollout-id", help="Stable rollout ID to record.")

    compare = subparsers.add_parser("compare", help="Compare pre/post deploy KPI fixtures.")
    add_common_kpi_args(compare, "pre", "post")

    rollback = subparsers.add_parser("rollback-check", help="Evaluate whether rollback should auto-trigger.")
    add_common_kpi_args(rollback, "baseline", "current")
    rollback.add_argument("--candidate-id", help="Candidate strategy/model identifier.")
    rollback.add_argument("--previous-deploy-ref", help="Previously approved deploy reference.")
    rollback.add_argument("--current-deploy-ref", help="Current candidate deploy reference.")
    rollback.add_argument("--rollout-id", help="Stable rollout ID to record.")

    return parser


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        if args.command == "contract":
            write_output(build_gate_contract(), args.output, stdout)
            return 0

        if args.command == "dry-run":
            pre = load_json(args.pre)
            post = load_json(args.post)
            write_output(
                build_dry_run_decision(
                    pre,
                    post,
                    candidate_id=args.candidate_id,
                    deploy_ref=args.deploy_ref,
                    created_at=args.created_at,
                    rollout_id=args.rollout_id,
                    pre_source=str(args.pre),
                    post_source=str(args.post),
                ),
                args.output,
                stdout,
            )
            return 0

        if args.command == "compare":
            pre = load_json(args.pre)
            post = load_json(args.post)
            write_output(
                build_kpi_comparison(
                    pre,
                    post,
                    created_at=args.created_at,
                    pre_source=str(args.pre),
                    post_source=str(args.post),
                ),
                args.output,
                stdout,
            )
            return 0

        if args.command == "rollback-check":
            baseline = load_json(args.baseline)
            current = load_json(args.current)
            write_output(
                build_rollback_check(
                    baseline,
                    current,
                    candidate_id=args.candidate_id,
                    previous_deploy_ref=args.previous_deploy_ref,
                    current_deploy_ref=args.current_deploy_ref,
                    created_at=args.created_at,
                    rollout_id=args.rollout_id,
                    baseline_source=str(args.baseline),
                    current_source=str(args.current),
                ),
                args.output,
                stdout,
            )
            return 0

        parser.error(f"unsupported command: {args.command}")
    except RolloutManagerError as error:
        stderr.write(f"error: {error}\n")
        return 2
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
