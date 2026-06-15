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


JsonObject = dict[str, Any]

SCHEMA_VERSION = 1
CONTRACT_VERSION = 1
CONTRACT_TYPE = "screeps-rl-rollout-gate-contract"
CANARY_CONTRACT_TYPE = "screeps-rl-safe-canary-contract"
CANARY_PLAN_TYPE = "screeps-rl-bounded-live-canary-plan"
SCORECARD_TYPE = "screeps-rl-evaluation-scorecard"
COMPARISON_TYPE = "screeps-rl-post-rollout-kpi-comparison"
DECISION_TYPE = "screeps-rl-rollout-decision"
ROLLBACK_TYPE = "screeps-rl-rollback-check"
DEFAULT_OBSERVATION_WINDOW_HOURS = 8.0
DEFAULT_MIN_OBSERVATION_SAMPLES = 8
DEFAULT_SECONDS_PER_TICK = 3.0
METRIC_ORDER = ("reliability", "territory", "resources", "kills")
LIVE_INFLUENCE_STATES = ("none", "shadow", "canary", "active", "rolled_back")
DEFAULT_LIVE_INFLUENCE_STATE = "none"
DEFAULT_LIVE_INFLUENCE_SURFACE = "none"
LIVE_INFLUENCE_STATES_REQUIRING_REFS = ("canary", "active", "rolled_back")
CANARY_PLAN_PASS_STATUSES = ("pass", "passed", "ok", "stable", "ready", "accepted")
CANARY_PLAN_ACTIVE_WORLD_STATUS = "matched_main"
CANARY_PLAN_SCORECARD_PASS_STATUS = "PASS"
CANARY_PLAN_SCORECARD_STATUS_VALUES = (
    CANARY_PLAN_SCORECARD_PASS_STATUS,
    "HOLD",
    "MIXED",
    "ROLLBACK_REQUIRED",
    "INCONCLUSIVE",
)
ALLOWED_LIVE_INFLUENCE_SURFACES: dict[str, JsonObject] = {
    "none": {
        "description": "no learned/tuned candidate influence reaches official MMO behavior",
        "liveEffect": False,
    },
    "recommendation_only": {
        "description": "candidate emits recommendations only; production behavior remains incumbent-controlled",
        "liveEffect": False,
    },
    "bounded_high_level_strategy_knobs": {
        "description": "candidate may affect only bounded high-level strategy knobs after validator veto",
        "liveEffect": True,
    },
}
FORBIDDEN_LIVE_INFLUENCE_SURFACES = (
    "raw_creep_intents",
    "spawn_intents",
    "construction_intents",
    "memory_writes",
    "raw_memory_writes",
    "market_orders",
    "official_mmo_writes",
)
EPSILON = 1e-9

DEFAULT_STRATEGY_KNOB_LIMITS: dict[str, tuple[float, float]] = {
    "constructionPriority.extensionWeight": (0.0, 5.0),
    "constructionPriority.containerWeight": (0.0, 5.0),
    "constructionPriority.towerWeight": (0.0, 5.0),
    "constructionPriority.rampartWeight": (0.0, 5.0),
    "constructionPriority.roadWeight": (0.0, 3.0),
    "expansionScoring.distanceWeight": (0.0, 3.0),
    "expansionScoring.sourceCountWeight": (0.0, 5.0),
    "expansionScoring.hostileRiskWeight": (0.0, 5.0),
    "remoteScoring.reservationPriorityWeight": (0.0, 5.0),
}


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


def normalize_contract_text(value: str | None, default: str) -> str:
    if value is None or value == "":
        return default
    return value


def normalize_status_text(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower().replace("-", "_").replace(" ", "_")
    return normalized or None


def status_is_pass(value: str | None) -> bool:
    normalized = normalize_status_text(value)
    return normalized in CANARY_PLAN_PASS_STATUSES if normalized is not None else False


def normalize_scorecard_status(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().upper().replace("-", "_").replace(" ", "_")
    return normalized or None


def text_present(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


def parse_bool_arg(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in ("1", "true", "yes", "y", "ok", "pass"):
        return True
    if normalized in ("0", "false", "no", "n", "fail", "blocked"):
        return False
    raise argparse.ArgumentTypeError(f"expected boolean value, got {value!r}")


def parse_key_value_arg(value: str) -> tuple[str, str]:
    key, separator, status = value.partition("=")
    if not separator or not key.strip() or not status.strip():
        raise argparse.ArgumentTypeError("expected KEY=VALUE")
    return key.strip(), status.strip()


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


def observation_requirements() -> JsonObject:
    return {
        "preWindow": {
            "hours": DEFAULT_OBSERVATION_WINDOW_HOURS,
            "minimumSamples": DEFAULT_MIN_OBSERVATION_SAMPLES,
        },
        "postWindow": {
            "hours": DEFAULT_OBSERVATION_WINDOW_HOURS,
            "minimumSamples": DEFAULT_MIN_OBSERVATION_SAMPLES,
        },
    }


def rollback_thresholds() -> JsonObject:
    thresholds: JsonObject = {}
    for key in METRIC_ORDER:
        spec = METRIC_SPECS[key]
        threshold: JsonObject = {"direction": "higher_is_better"}
        if spec.max_degradation_absolute is not None:
            threshold["maxDegradationAbsolute"] = round_float(spec.max_degradation_absolute)
        if spec.max_degradation_percent is not None:
            threshold["maxDegradationPercent"] = round_float(spec.max_degradation_percent)
        if spec.minimum_post_value is not None:
            threshold["minimumPostValue"] = round_float(spec.minimum_post_value)
        thresholds[key] = threshold
    return thresholds


def strategy_knob_limits() -> JsonObject:
    return {
        key: {
            "max": round_float(maximum),
            "min": round_float(minimum),
            "validator": "candidate value must be finite and inside this inclusive range before use",
        }
        for key, (minimum, maximum) in DEFAULT_STRATEGY_KNOB_LIMITS.items()
    }


def validator_requirements() -> JsonObject:
    return {
        "deterministicVetoRequired": True,
        "defaultOnMissingValidator": "veto",
        "requirements": [
            "reject forbidden live influence surfaces before canary",
            "reject missing incumbent baseline, candidate deploy, or rollback refs before canary",
            "reject non-finite or out-of-bounds strategy knob values",
            "reject any raw intent, Memory/RawMemory, market, or direct official MMO write authority",
        ],
    }


def build_safe_canary_contract(
    *,
    candidate_id: str | None = None,
    deploy_ref: str | None = None,
    rollback_ref: str | None = None,
    incumbent_baseline_ref: str | None = None,
    live_influence_state: str | None = None,
    live_influence_surface: str | None = None,
    created_at: str | None = None,
    baseline_source: str | None = None,
) -> JsonObject:
    state = normalize_contract_text(live_influence_state, DEFAULT_LIVE_INFLUENCE_STATE)
    surface = normalize_contract_text(live_influence_surface, DEFAULT_LIVE_INFLUENCE_SURFACE)
    surface_contract = ALLOWED_LIVE_INFLUENCE_SURFACES.get(surface)
    violations: list[JsonObject] = []

    if state not in LIVE_INFLUENCE_STATES:
        violations.append(
            {
                "field": "liveInfluence.state",
                "reason": "invalid_live_influence_state",
                "value": state,
            }
        )

    if surface in FORBIDDEN_LIVE_INFLUENCE_SURFACES:
        violations.append(
            {
                "field": "liveInfluence.allowedSurface",
                "reason": "forbidden_live_influence_surface",
                "value": surface,
            }
        )
    elif surface_contract is None:
        violations.append(
            {
                "field": "liveInfluence.allowedSurface",
                "reason": "unknown_live_influence_surface",
                "value": surface,
            }
        )

    if state in LIVE_INFLUENCE_STATES_REQUIRING_REFS:
        required_fields = (
            ("incumbentBaseline.ref", incumbent_baseline_ref, "missing_incumbent_baseline_ref"),
            ("candidate.id", candidate_id, "missing_candidate_id"),
            ("candidate.deployRef", deploy_ref, "missing_candidate_deploy_ref"),
            ("rollback.ref", rollback_ref, "missing_rollback_ref"),
        )
        for field, value, reason in required_fields:
            if value is None or value == "":
                violations.append({"field": field, "reason": reason})
        if surface == "none":
            violations.append(
                {
                    "field": "liveInfluence.allowedSurface",
                    "reason": "live_influence_requires_safe_surface",
                    "value": surface,
                }
            )

    return {
        "type": CANARY_CONTRACT_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "contractVersion": CONTRACT_VERSION,
        "allowedLiveInfluenceStates": list(LIVE_INFLUENCE_STATES),
        "candidate": {
            "deployRef": deploy_ref,
            "id": candidate_id,
        },
        "createdAt": created_at,
        "incumbentBaseline": {
            "ref": incumbent_baseline_ref,
            "requiredBeforeCanary": True,
            "sourcePath": baseline_source,
        },
        "liveInfluence": {
            "allowedSurface": surface,
            "allowedSurfaceContract": surface_contract,
            "forbiddenSurfaces": list(FORBIDDEN_LIVE_INFLUENCE_SURFACES),
            "officialMmoWritesAllowed": False,
            "state": state,
            "trainingEvaluationOfficialMmoWritesAllowed": False,
        },
        "rollback": {
            "ref": rollback_ref,
            "requiredBeforeCanary": True,
        },
        "rollbackThresholds": rollback_thresholds(),
        "sampleRequirements": observation_requirements(),
        "strategyKnobLimits": strategy_knob_limits(),
        "validation": {
            "status": "fail" if violations else "pass",
            "violations": violations,
        },
        "validators": validator_requirements(),
    }


def canary_blocking_reasons(canary_contract: JsonObject) -> list[JsonObject]:
    validation = canary_contract.get("validation")
    if not isinstance(validation, dict):
        return [{"scope": "safeCanary", "reason": "missing_canary_validation"}]
    violations = validation.get("violations")
    if not isinstance(violations, list):
        return [{"scope": "safeCanary", "reason": "missing_canary_violations"}]
    return [{"scope": "safeCanary", **violation} for violation in violations if isinstance(violation, dict)]


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
        "safeCanary": build_safe_canary_contract(),
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


def evaluate_window_requirements(window: JsonObject, label: str) -> list[JsonObject]:
    checks: list[JsonObject] = []

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

    return checks


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
        checks.extend(evaluate_window_requirements(window, label))

    return {
        "checks": checks,
        "requiredHours": DEFAULT_OBSERVATION_WINDOW_HOURS,
        "requiredSamples": DEFAULT_MIN_OBSERVATION_SAMPLES,
        "status": "fail" if any(check["status"] == "fail" for check in checks) else "pass",
    }


def build_baseline_readiness(baseline_raw: JsonObject | None, baseline_source: str | None) -> JsonObject:
    if baseline_raw is None:
        return {
            "blockingReasons": [{"field": "baselineKpi", "reason": "missing_baseline_kpi_window"}],
            "metrics": {key: None for key in METRIC_ORDER},
            "observation": {
                "checks": [],
                "requiredHours": DEFAULT_OBSERVATION_WINDOW_HOURS,
                "requiredSamples": DEFAULT_MIN_OBSERVATION_SAMPLES,
                "status": "fail",
            },
            "rawType": None,
            "status": "fail",
            "window": {"sourcePath": baseline_source},
        }

    baseline = normalize_kpi_window(baseline_raw, baseline_source)
    checks = evaluate_window_requirements(baseline["window"], "baseline")
    blocking_reasons: list[JsonObject] = [
        {"scope": "baselineObservation", **check} for check in checks if check.get("status") == "fail"
    ]
    metric_checks: list[JsonObject] = []
    for key, value in baseline["metrics"].items():
        check = {
            "metric": key,
            "reason": "missing_baseline_metric" if value is None else "observed",
            "status": "fail" if value is None else "pass",
        }
        metric_checks.append(check)
        if value is None:
            blocking_reasons.append({"metric": key, "reason": "missing_baseline_metric", "scope": "baselineMetric"})

    observation = {
        "checks": checks,
        "requiredHours": DEFAULT_OBSERVATION_WINDOW_HOURS,
        "requiredSamples": DEFAULT_MIN_OBSERVATION_SAMPLES,
        "status": "fail" if any(check["status"] == "fail" for check in checks) else "pass",
    }
    status = "fail" if blocking_reasons else "pass"
    return {
        "blockingReasons": blocking_reasons,
        "metricChecks": metric_checks,
        "metrics": baseline["metrics"],
        "observation": observation,
        "rawType": baseline["rawType"],
        "status": status,
        "window": baseline["window"],
    }


def build_planning_safety_guards(
    *,
    official_mmo_write_allowed: bool = False,
    paid_compute_allowed: bool = False,
) -> JsonObject:
    return {
        "deploysCode": False,
        "launchesCanary": False,
        "officialMmoWritesAllowedDuringPlanning": official_mmo_write_allowed,
        "paidComputeAllowed": paid_compute_allowed,
        "planGeneratedOnly": True,
        "prohibitedActions": [
            "do not launch Tencent paid compute",
            "do not scale ASGs",
            "do not run official deploy",
            "do not write official MMO state",
            "do not train a new model",
            "do not bypass validation-plan or no-compute guards",
        ],
        "trainsModel": False,
        "writesOfficialMmo": False,
    }


def canary_plan_safety_blocking_reasons(safety: JsonObject) -> list[JsonObject]:
    reasons: list[JsonObject] = []
    if safety.get("paidComputeAllowed") is not False:
        reasons.append({"field": "safetyGuards.paidComputeAllowed", "reason": "paid_compute_must_remain_held"})
    if safety.get("officialMmoWritesAllowedDuringPlanning") is not False:
        reasons.append(
            {
                "field": "safetyGuards.officialMmoWritesAllowedDuringPlanning",
                "reason": "official_mmo_writes_must_remain_disallowed",
            }
        )
    for field in ("deploysCode", "launchesCanary", "trainsModel", "writesOfficialMmo"):
        if safety.get(field) is not False:
            reasons.append({"field": f"safetyGuards.{field}", "reason": "planning_gate_must_not_execute_actions"})
    return [{"scope": "safety", **reason} for reason in reasons]


def canary_plan_text_blocking_reasons(fields: tuple[tuple[str, Any, str], ...]) -> list[JsonObject]:
    return [
        {"field": field, "reason": reason, "scope": "readiness"}
        for field, value, reason in fields
        if not text_present(value)
    ]


def build_candidate_scorecard_gate(
    scorecard_raw: JsonObject | None,
    scorecard_ref: str | None,
    *,
    candidate_id: str | None = None,
    deploy_ref: str | None = None,
    incumbent_baseline_ref: str | None = None,
) -> JsonObject:
    reasons: list[JsonObject] = []
    overall_status: str | None = None
    safety_regressions: list[Any] = []
    non_safety_regressions: list[Any] = []
    runtime_gate: JsonObject = {}
    monotonic: JsonObject = {}

    if not text_present(scorecard_ref):
        reasons.append(
            {
                "field": "candidate.scorecardRef",
                "reason": "missing_candidate_scorecard_ref",
                "scope": "scorecardGate",
            }
        )
    elif scorecard_raw is None:
        reasons.append(
            {
                "field": "candidate.scorecardRef",
                "reason": "missing_candidate_scorecard_artifact",
                "scope": "scorecardGate",
            }
        )
    else:
        if scorecard_raw.get("type") != SCORECARD_TYPE:
            reasons.append(
                {
                    "actual": scorecard_raw.get("type"),
                    "field": "candidate.scorecard.type",
                    "reason": "invalid_candidate_scorecard_type",
                    "required": SCORECARD_TYPE,
                    "scope": "scorecardGate",
                }
            )

        scorecard_candidate = scorecard_raw.get("candidate")
        scorecard_candidate = scorecard_candidate if isinstance(scorecard_candidate, dict) else {}
        scorecard_candidate_id = scorecard_candidate.get("id")
        if not text_present(scorecard_candidate_id):
            reasons.append(
                {
                    "field": "candidate.scorecard.candidate.id",
                    "reason": "missing_candidate_scorecard_candidate_id",
                    "scope": "scorecardGate",
                }
            )
        elif text_present(candidate_id) and scorecard_candidate_id != candidate_id:
            reasons.append(
                {
                    "actual": scorecard_candidate_id,
                    "field": "candidate.scorecard.candidate.id",
                    "reason": "candidate_scorecard_candidate_id_mismatch",
                    "required": candidate_id,
                    "scope": "scorecardGate",
                }
            )

        scorecard_candidate_commit = scorecard_candidate.get("commit")
        scorecard_candidate_deploy_ref = scorecard_candidate.get("deployRef")
        if (
            text_present(deploy_ref)
            and not text_present(scorecard_candidate_commit)
            and not text_present(scorecard_candidate_deploy_ref)
        ):
            reasons.append(
                {
                    "field": "candidate.scorecard.candidate.deployBinding",
                    "reason": "missing_candidate_scorecard_deploy_binding",
                    "required": deploy_ref,
                    "scope": "scorecardGate",
                }
            )
        if (
            text_present(scorecard_candidate_commit)
            and text_present(deploy_ref)
            and scorecard_candidate_commit != deploy_ref
        ):
            reasons.append(
                {
                    "actual": scorecard_candidate_commit,
                    "field": "candidate.scorecard.candidate.commit",
                    "reason": "candidate_scorecard_candidate_commit_mismatch",
                    "required": deploy_ref,
                    "scope": "scorecardGate",
                }
            )

        if (
            text_present(scorecard_candidate_deploy_ref)
            and text_present(deploy_ref)
            and scorecard_candidate_deploy_ref != deploy_ref
        ):
            reasons.append(
                {
                    "actual": scorecard_candidate_deploy_ref,
                    "field": "candidate.scorecard.candidate.deployRef",
                    "reason": "candidate_scorecard_candidate_deploy_ref_mismatch",
                    "required": deploy_ref,
                    "scope": "scorecardGate",
                }
            )

        scorecard_baseline = scorecard_raw.get("baseline")
        scorecard_baseline = scorecard_baseline if isinstance(scorecard_baseline, dict) else {}
        scorecard_baseline_commit = scorecard_baseline.get("commit")
        scorecard_baseline_deploy_ref = scorecard_baseline.get("deployRef")
        if (
            text_present(incumbent_baseline_ref)
            and not text_present(scorecard_baseline_commit)
            and not text_present(scorecard_baseline_deploy_ref)
        ):
            reasons.append(
                {
                    "field": "candidate.scorecard.baseline.binding",
                    "reason": "missing_candidate_scorecard_baseline_binding",
                    "required": incumbent_baseline_ref,
                    "scope": "scorecardGate",
                }
            )
        if (
            text_present(scorecard_baseline_commit)
            and text_present(incumbent_baseline_ref)
            and scorecard_baseline_commit != incumbent_baseline_ref
        ):
            reasons.append(
                {
                    "actual": scorecard_baseline_commit,
                    "field": "candidate.scorecard.baseline.commit",
                    "reason": "candidate_scorecard_baseline_commit_mismatch",
                    "required": incumbent_baseline_ref,
                    "scope": "scorecardGate",
                }
            )
        if (
            text_present(scorecard_baseline_deploy_ref)
            and text_present(incumbent_baseline_ref)
            and scorecard_baseline_deploy_ref != incumbent_baseline_ref
        ):
            reasons.append(
                {
                    "actual": scorecard_baseline_deploy_ref,
                    "field": "candidate.scorecard.baseline.deployRef",
                    "reason": "candidate_scorecard_baseline_deploy_ref_mismatch",
                    "required": incumbent_baseline_ref,
                    "scope": "scorecardGate",
                }
            )

        overall_gate = scorecard_raw.get("overallGate")
        if not isinstance(overall_gate, dict):
            reasons.append(
                {
                    "field": "candidate.scorecard.overallGate",
                    "reason": "missing_candidate_scorecard_overall_gate",
                    "scope": "scorecardGate",
                }
            )
            overall_gate = {}

        overall_status = normalize_scorecard_status(overall_gate.get("status"))
        if overall_status != CANARY_PLAN_SCORECARD_PASS_STATUS:
            reasons.append(
                {
                    "actual": overall_status,
                    "allowedStatusValues": list(CANARY_PLAN_SCORECARD_STATUS_VALUES),
                    "field": "candidate.scorecard.overallGate.status",
                    "reason": "candidate_scorecard_status_must_pass",
                    "required": CANARY_PLAN_SCORECARD_PASS_STATUS,
                    "scope": "scorecardGate",
                }
            )

        raw_safety_regressions = overall_gate.get("safetyRegressions")
        safety_regressions = list(raw_safety_regressions) if isinstance(raw_safety_regressions, list) else []
        if safety_regressions:
            reasons.append(
                {
                    "actual": safety_regressions,
                    "field": "candidate.scorecard.overallGate.safetyRegressions",
                    "reason": "candidate_scorecard_safety_regressions",
                    "required": [],
                    "scope": "scorecardGate",
                }
            )

        raw_non_safety_regressions = overall_gate.get("nonSafetyRegressions")
        non_safety_regressions = (
            list(raw_non_safety_regressions) if isinstance(raw_non_safety_regressions, list) else []
        )
        if non_safety_regressions:
            reasons.append(
                {
                    "actual": non_safety_regressions,
                    "field": "candidate.scorecard.overallGate.nonSafetyRegressions",
                    "reason": "candidate_scorecard_dimension_regressions",
                    "required": [],
                    "scope": "scorecardGate",
                }
            )

        raw_runtime_gate = overall_gate.get("runtimeCandidateGate")
        runtime_gate = dict(raw_runtime_gate) if isinstance(raw_runtime_gate, dict) else {}
        raw_monotonic = overall_gate.get("monotonic")
        monotonic = dict(raw_monotonic) if isinstance(raw_monotonic, dict) else {}

        if not safety_regressions and monotonic.get("noSafetyRegression") is not True:
            reasons.append(
                {
                    "actual": monotonic.get("noSafetyRegression"),
                    "field": "candidate.scorecard.overallGate.monotonic.noSafetyRegression",
                    "reason": "candidate_scorecard_no_safety_regression_not_proven",
                    "required": True,
                    "scope": "scorecardGate",
                }
            )
        if not non_safety_regressions and monotonic.get("noDimensionRegression") is not True:
            reasons.append(
                {
                    "actual": monotonic.get("noDimensionRegression"),
                    "field": "candidate.scorecard.overallGate.monotonic.noDimensionRegression",
                    "reason": "candidate_scorecard_no_dimension_regression_not_proven",
                    "required": True,
                    "scope": "scorecardGate",
                }
            )

        runtime_injection_proven = (
            runtime_gate.get("runtimeParameterInjection") is True
            and runtime_gate.get("runtimeParameterConsumption") is True
            and monotonic.get("runtimeParameterInjectionProven") is True
        )
        if not runtime_injection_proven:
            reasons.append(
                {
                    "actual": {
                        "runtimeParameterConsumption": runtime_gate.get("runtimeParameterConsumption"),
                        "runtimeParameterInjection": runtime_gate.get("runtimeParameterInjection"),
                        "runtimeParameterInjectionProven": monotonic.get("runtimeParameterInjectionProven"),
                    },
                    "field": "candidate.scorecard.overallGate.runtimeCandidateGate",
                    "reason": "candidate_scorecard_runtime_injection_not_proven",
                    "required": True,
                    "scope": "scorecardGate",
                }
            )

    return {
        "blockingReasons": reasons,
        "nonSafetyRegressions": non_safety_regressions,
        "overallStatus": overall_status,
        "runtimeCandidateGate": runtime_gate,
        "safetyRegressions": safety_regressions,
        "sourceArtifact": scorecard_ref,
        "status": "hold" if reasons else "pass",
    }


def build_canary_readiness_plan(
    *,
    active_world_ref: str | None = None,
    active_world_status: str | None = None,
    baseline_raw: JsonObject | None = None,
    baseline_source: str | None = None,
    candidate_id: str | None = None,
    conclusion_records: list[tuple[str, str]] | None = None,
    conclusion_registry_ref: str | None = None,
    conclusion_summary: str | None = None,
    construction_acceptance_status: str | None = None,
    cpu_baseline_ref: str | None = None,
    cpu_baseline_status: str | None = None,
    created_at: str | None = None,
    deploy_artifact: str | None = None,
    deploy_ref: str | None = None,
    health_gate_ok: bool | None = None,
    incumbent_baseline_ref: str | None = None,
    live_influence_state: str | None = "canary",
    live_influence_surface: str | None = "bounded_high_level_strategy_knobs",
    official_deploy_head: str | None = None,
    official_deploy_run_id: str | None = None,
    official_mmo_write_allowed: bool = False,
    owned_creeps: float | int | None = None,
    owned_spawns: float | int | None = None,
    paid_compute_allowed: bool = False,
    postdeploy_alert: bool | None = None,
    postdeploy_alert_artifact: str | None = None,
    postdeploy_health_gate_artifact: str | None = None,
    postdeploy_summary_artifact: str | None = None,
    rollback_ref: str | None = None,
    scorecard_raw: JsonObject | None = None,
    scorecard_ref: str | None = None,
) -> JsonObject:
    created = created_at or utc_now_iso()
    baseline = build_baseline_readiness(baseline_raw, baseline_source)
    canary_contract = build_safe_canary_contract(
        candidate_id=candidate_id,
        deploy_ref=deploy_ref,
        rollback_ref=rollback_ref,
        incumbent_baseline_ref=incumbent_baseline_ref,
        live_influence_state=live_influence_state,
        live_influence_surface=live_influence_surface,
        created_at=created,
        baseline_source=baseline_source,
    )
    safety = build_planning_safety_guards(
        official_mmo_write_allowed=official_mmo_write_allowed,
        paid_compute_allowed=paid_compute_allowed,
    )
    normalized_active_world = normalize_status_text(active_world_status)
    normalized_construction = normalize_status_text(construction_acceptance_status)
    normalized_cpu = normalize_status_text(cpu_baseline_status)
    spawn_count = number_or_none(owned_spawns)
    creep_count = number_or_none(owned_creeps)
    scorecard_gate = build_candidate_scorecard_gate(
        scorecard_raw,
        scorecard_ref,
        candidate_id=candidate_id,
        deploy_ref=deploy_ref,
        incumbent_baseline_ref=incumbent_baseline_ref,
    )

    blocking_reasons: list[JsonObject] = []
    blocking_reasons.extend(baseline["blockingReasons"])
    blocking_reasons.extend(canary_blocking_reasons(canary_contract))
    blocking_reasons.extend(scorecard_gate["blockingReasons"])
    blocking_reasons.extend(canary_plan_safety_blocking_reasons(safety))
    blocking_reasons.extend(
        canary_plan_text_blocking_reasons(
            (
                ("controlLoop.conclusionRegistryRef", conclusion_registry_ref, "missing_conclusion_registry_ref"),
                ("officialDeploy.head", official_deploy_head, "missing_official_deploy_head"),
                ("officialDeploy.runId", official_deploy_run_id, "missing_official_deploy_run_id"),
                ("officialDeploy.artifacts.deploy", deploy_artifact, "missing_official_deploy_artifact"),
                (
                    "officialDeploy.artifacts.postdeploySummary",
                    postdeploy_summary_artifact,
                    "missing_postdeploy_summary_artifact",
                ),
                (
                    "officialDeploy.artifacts.postdeployHealthGate",
                    postdeploy_health_gate_artifact,
                    "missing_postdeploy_health_gate_artifact",
                ),
                (
                    "officialDeploy.artifacts.postdeployAlert",
                    postdeploy_alert_artifact,
                    "missing_postdeploy_alert_artifact",
                ),
            )
        )
    )

    if not conclusion_records:
        blocking_reasons.append(
            {
                "field": "controlLoop.conclusions",
                "reason": "missing_conclusion_records",
                "scope": "controlLoop",
            }
        )
    if normalized_active_world != CANARY_PLAN_ACTIVE_WORLD_STATUS:
        blocking_reasons.append(
            {
                "actual": active_world_status,
                "field": "officialDeploy.activeWorldStatus",
                "reason": "active_world_must_match_main",
                "required": CANARY_PLAN_ACTIVE_WORLD_STATUS,
                "scope": "officialDeploy",
            }
        )
    if health_gate_ok is not True:
        blocking_reasons.append(
            {
                "actual": health_gate_ok,
                "field": "officialDeploy.healthGateOk",
                "reason": "postdeploy_health_gate_must_be_ok",
                "scope": "officialDeploy",
            }
        )
    if postdeploy_alert is not False:
        blocking_reasons.append(
            {
                "actual": postdeploy_alert,
                "field": "officialDeploy.alert",
                "reason": "postdeploy_alert_must_be_false",
                "scope": "officialDeploy",
            }
        )
    if normalized_construction != "pass":
        blocking_reasons.append(
            {
                "actual": construction_acceptance_status,
                "field": "constructionGate.status",
                "reason": "construction_acceptance_must_pass",
                "required": "pass",
                "scope": "constructionGate",
            }
        )
    if not status_is_pass(cpu_baseline_status):
        blocking_reasons.append(
            {
                "actual": cpu_baseline_status,
                "field": "cpuGate.status",
                "reason": "cpu_baseline_must_pass",
                "scope": "cpuGate",
            }
        )
    elif not text_present(cpu_baseline_ref):
        blocking_reasons.append(
            {
                "actual": cpu_baseline_ref,
                "field": "cpuGate.sourceArtifact",
                "reason": "missing_cpu_baseline_ref",
                "scope": "cpuGate",
            }
        )
    if spawn_count is None or spawn_count < 1:
        blocking_reasons.append(
            {
                "actual": owned_spawns,
                "field": "officialDeploy.ownedSpawns",
                "reason": "owned_spawn_count_must_be_positive",
                "scope": "officialDeploy",
            }
        )
    if creep_count is None or creep_count < 1:
        blocking_reasons.append(
            {
                "actual": owned_creeps,
                "field": "officialDeploy.ownedCreeps",
                "reason": "owned_creep_count_must_be_positive",
                "scope": "officialDeploy",
            }
        )

    readiness_status = "hold" if blocking_reasons else "ready"
    return {
        "type": CANARY_PLAN_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "canaryContract": canary_contract,
        "candidate": {
            "deployRef": deploy_ref,
            "id": candidate_id,
            "scorecardRef": scorecard_ref,
        },
        "controlLoop": {
            "conclusionRegistryRef": conclusion_registry_ref,
            "conclusions": [
                {"conclusionId": conclusion_id, "status": status}
                for conclusion_id, status in (conclusion_records or [])
            ],
            "summary": conclusion_summary,
        },
        "createdAt": created,
        "cpuGate": {
            "sourceArtifact": cpu_baseline_ref,
            "status": normalized_cpu,
        },
        "scorecardGate": scorecard_gate,
        "constructionGate": {
            "postdeployHealthGateArtifact": postdeploy_health_gate_artifact,
            "status": normalized_construction,
        },
        "incumbentBaseline": {
            "kpiWindow": baseline,
            "ref": incumbent_baseline_ref,
        },
        "issue": "#1583",
        "mode": "planning_only",
        "officialDeploy": {
            "activeWorldRef": active_world_ref,
            "activeWorldStatus": normalized_active_world,
            "alert": postdeploy_alert,
            "artifacts": {
                "deploy": deploy_artifact,
                "postdeployAlert": postdeploy_alert_artifact,
                "postdeployHealthGate": postdeploy_health_gate_artifact,
                "postdeploySummary": postdeploy_summary_artifact,
            },
            "head": official_deploy_head,
            "healthGateOk": health_gate_ok,
            "ownedCreeps": round_float(creep_count) if creep_count is not None else owned_creeps,
            "ownedSpawns": round_float(spawn_count) if spawn_count is not None else owned_spawns,
            "runId": official_deploy_run_id,
        },
        "readiness": {
            "blockingReasons": blocking_reasons,
            "nextAction": (
                "controller may run the bounded canary dry-run/rollback gate with these refs"
                if readiness_status == "ready"
                else "do not launch canary; satisfy the blocking readiness reasons first"
            ),
            "status": readiness_status,
        },
        "rollbackTrigger": rollback_trigger_spec(),
        "safetyGuards": safety,
    }


def build_kpi_comparison(
    pre_raw: JsonObject,
    post_raw: JsonObject,
    *,
    candidate_id: str | None = None,
    created_at: str | None = None,
    deploy_ref: str | None = None,
    incumbent_baseline_ref: str | None = None,
    live_influence_state: str | None = None,
    live_influence_surface: str | None = None,
    pre_source: str | None = None,
    post_source: str | None = None,
    require_complete_window: bool = True,
    rollback_ref: str | None = None,
) -> JsonObject:
    created = created_at or utc_now_iso()
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
    canary_contract = build_safe_canary_contract(
        candidate_id=candidate_id,
        deploy_ref=deploy_ref,
        rollback_ref=rollback_ref,
        incumbent_baseline_ref=incumbent_baseline_ref,
        live_influence_state=live_influence_state,
        live_influence_surface=live_influence_surface,
        created_at=created,
        baseline_source=pre_source,
    )
    canary_passed = canary_contract["validation"]["status"] == "pass"
    return {
        "type": COMPARISON_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "contractVersion": CONTRACT_VERSION,
        "canaryContract": canary_contract,
        "createdAt": created,
        "gateStatus": "pass"
        if observation["status"] in ("pass", "not_required_for_mode")
        and all(metric["status"] == "pass" for metric in metrics.values())
        and canary_passed
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
    reasons.extend(canary_blocking_reasons(comparison.get("canaryContract", {})))
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
    incumbent_baseline_ref: str | None = None,
    created_at: str | None = None,
    live_influence_state: str | None = None,
    live_influence_surface: str | None = None,
    rollout_id: str | None = None,
    pre_source: str | None = None,
    post_source: str | None = None,
    rollback_ref: str | None = None,
) -> JsonObject:
    created = created_at or utc_now_iso()
    comparison = build_kpi_comparison(
        pre_raw,
        post_raw,
        candidate_id=candidate_id,
        created_at=created,
        deploy_ref=deploy_ref,
        incumbent_baseline_ref=incumbent_baseline_ref,
        live_influence_state=live_influence_state,
        live_influence_surface=live_influence_surface,
        pre_source=pre_source,
        post_source=post_source,
        require_complete_window=True,
        rollback_ref=rollback_ref,
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
        "canaryContract": comparison["canaryContract"],
        "candidate": {
            "deployRef": deploy_ref,
            "id": candidate_id,
            "incumbentBaselineRef": incumbent_baseline_ref,
            "rollbackRef": rollback_ref,
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


def evaluate_rollback_evidence_contract(
    comparison: JsonObject,
    canary_contract: JsonObject,
) -> JsonObject:
    checks: list[JsonObject] = []
    checks.extend(canary_blocking_reasons(canary_contract))

    for label, window in (("baseline", comparison["pre"]["window"]), ("current", comparison["post"]["window"])):
        duration = number_or_none(window.get("durationHours"))
        if duration is None:
            checks.append({"label": label, "reason": "missing_duration_hours", "scope": "rollbackEvidence"})

        sample_count = number_or_none(window.get("sampleCount"))
        if sample_count is None:
            checks.append({"label": label, "reason": "missing_sample_count", "scope": "rollbackEvidence"})
        elif sample_count <= 0:
            checks.append(
                {
                    "actualSamples": round_float(sample_count),
                    "label": label,
                    "reason": "empty_sample_window",
                    "scope": "rollbackEvidence",
                }
            )

    return {
        "checks": checks,
        "status": "fail" if checks else "pass",
    }


def build_rollback_check(
    baseline_raw: JsonObject,
    current_raw: JsonObject,
    *,
    candidate_id: str | None = None,
    previous_deploy_ref: str | None = None,
    current_deploy_ref: str | None = None,
    incumbent_baseline_ref: str | None = None,
    created_at: str | None = None,
    live_influence_state: str | None = "canary",
    live_influence_surface: str | None = "bounded_high_level_strategy_knobs",
    rollout_id: str | None = None,
    baseline_source: str | None = None,
    current_source: str | None = None,
    rollback_ref: str | None = None,
) -> JsonObject:
    created = created_at or utc_now_iso()
    resolved_rollback_ref = rollback_ref or previous_deploy_ref
    comparison = build_kpi_comparison(
        baseline_raw,
        current_raw,
        candidate_id=candidate_id,
        created_at=created,
        deploy_ref=current_deploy_ref,
        incumbent_baseline_ref=incumbent_baseline_ref,
        live_influence_state=live_influence_state,
        live_influence_surface=live_influence_surface,
        pre_source=baseline_source,
        post_source=current_source,
        require_complete_window=False,
        rollback_ref=resolved_rollback_ref,
    )
    canary_contract = comparison["canaryContract"]
    rollback_evidence = evaluate_rollback_evidence_contract(comparison, canary_contract)
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
    fail_safe_reasons = rollback_evidence["checks"]
    rollback_triggered = bool((metric_triggers and in_window) or fail_safe_reasons)
    decision = "auto_revert" if rollback_triggered else "continue_observation"
    resolved_rollout_id = rollout_id or f"rl-rollout-{canonical_hash({'candidateId': candidate_id, 'createdAt': created})[:12]}"
    return {
        "type": ROLLBACK_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "canaryContract": canary_contract,
        "candidate": {
            "currentDeployRef": current_deploy_ref,
            "id": candidate_id,
            "incumbentBaselineRef": incumbent_baseline_ref,
            "previousDeployRef": previous_deploy_ref,
            "rollbackRef": resolved_rollback_ref,
        },
        "comparison": comparison,
        "createdAt": created,
        "currentWithinObservationWindow": in_window,
        "decision": decision,
        "failSafeReasons": fail_safe_reasons,
        "metricTriggers": metric_triggers,
        "rollbackEvidence": rollback_evidence,
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


def add_canary_args(
    parser: argparse.ArgumentParser,
    *,
    default_state: str = DEFAULT_LIVE_INFLUENCE_STATE,
    default_surface: str = DEFAULT_LIVE_INFLUENCE_SURFACE,
) -> None:
    parser.add_argument("--incumbent-baseline-ref", help="Incumbent baseline ref required before canary/active influence.")
    parser.add_argument("--rollback-ref", help="Rollback deploy ref required before canary/active influence.")
    parser.add_argument(
        "--live-influence-state",
        default=default_state,
        help="Live influence state: none, shadow, canary, active, or rolled_back.",
    )
    parser.add_argument(
        "--live-influence-surface",
        default=default_surface,
        help="Allowed surface: none, recommendation_only, or bounded_high_level_strategy_knobs.",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Evaluate KPI-gated RL rollout, rollback, and post-rollout comparison records.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    contract = subparsers.add_parser("contract", help="Print the KPI rollout gate contract.")
    contract.add_argument("--output", type=Path, help="Write JSON output to this path instead of stdout.")

    canary_plan = subparsers.add_parser(
        "canary-plan",
        help="Build a planning-only bounded live canary readiness record.",
    )
    canary_plan.add_argument("--baseline", type=Path, help="Incumbent baseline KPI JSON fixture/report.")
    canary_plan.add_argument("--candidate-id", help="Candidate strategy/model identifier.")
    canary_plan.add_argument("--deploy-ref", help="Candidate deploy reference or bundle ref.")
    canary_plan.add_argument("--scorecard-ref", help="Candidate-vs-baseline scorecard artifact ref.")
    canary_plan.add_argument("--active-world-ref", help="Active world branch/ref observed after official deploy.")
    canary_plan.add_argument(
        "--active-world-status",
        help="Expected to be matched_main after postdeploy evidence.",
    )
    canary_plan.add_argument("--official-deploy-head", help="Official deploy head SHA.")
    canary_plan.add_argument("--official-deploy-run-id", help="Official deploy workflow run id.")
    canary_plan.add_argument("--deploy-artifact", help="Official deploy JSON artifact path.")
    canary_plan.add_argument("--postdeploy-summary-artifact", help="Postdeploy summary artifact path.")
    canary_plan.add_argument("--postdeploy-health-gate-artifact", help="Postdeploy health-gate artifact path.")
    canary_plan.add_argument("--postdeploy-alert-artifact", help="Postdeploy alert artifact path.")
    canary_plan.add_argument("--health-gate-ok", type=parse_bool_arg, help="Whether the postdeploy health gate was ok.")
    canary_plan.add_argument("--postdeploy-alert", type=parse_bool_arg, help="Whether the postdeploy alert fired.")
    canary_plan.add_argument("--construction-acceptance-status", help="Postdeploy construction acceptance status.")
    canary_plan.add_argument("--owned-spawns", type=float, help="Owned spawn count from postdeploy evidence.")
    canary_plan.add_argument("--owned-creeps", type=float, help="Owned creep count from postdeploy evidence.")
    canary_plan.add_argument("--cpu-baseline-status", help="CPU baseline gate status.")
    canary_plan.add_argument("--cpu-baseline-ref", help="CPU baseline artifact/ref.")
    canary_plan.add_argument("--conclusion-registry-ref", help="RL conclusion registry artifact/ref.")
    canary_plan.add_argument("--conclusion-summary", help="Conclusion registry summary, for example ACTIONED=1,VALIDATING=1,CLOSED=2.")
    canary_plan.add_argument(
        "--conclusion",
        action="append",
        default=[],
        type=parse_key_value_arg,
        help="Conclusion status in CONCLUSION_ID=STATUS form. May be repeated.",
    )
    canary_plan.add_argument(
        "--paid-compute-allowed",
        action="store_true",
        help="Record that paid compute would be allowed; this intentionally blocks readiness.",
    )
    canary_plan.add_argument(
        "--official-mmo-write-allowed",
        action="store_true",
        help="Record that planning would allow official MMO writes; this intentionally blocks readiness.",
    )
    canary_plan.add_argument("--created-at", help="ISO UTC timestamp to record. Defaults to current UTC second.")
    canary_plan.add_argument("--output", type=Path, help="Write JSON output to this path instead of stdout.")
    add_canary_args(
        canary_plan,
        default_state="canary",
        default_surface="bounded_high_level_strategy_knobs",
    )

    dry_run = subparsers.add_parser("dry-run", help="Evaluate a dry-run rollout decision from pre/post KPI fixtures.")
    add_common_kpi_args(dry_run, "pre", "post")
    dry_run.add_argument("--candidate-id", help="Candidate strategy/model identifier.")
    dry_run.add_argument("--deploy-ref", help="Candidate deploy reference or commit.")
    dry_run.add_argument("--rollout-id", help="Stable rollout ID to record.")
    add_canary_args(dry_run)

    compare = subparsers.add_parser("compare", help="Compare pre/post deploy KPI fixtures.")
    add_common_kpi_args(compare, "pre", "post")
    compare.add_argument("--candidate-id", help="Candidate strategy/model identifier.")
    compare.add_argument("--deploy-ref", help="Candidate deploy reference or commit.")
    add_canary_args(compare)

    rollback = subparsers.add_parser("rollback-check", help="Evaluate whether rollback should auto-trigger.")
    add_common_kpi_args(rollback, "baseline", "current")
    rollback.add_argument("--candidate-id", help="Candidate strategy/model identifier.")
    rollback.add_argument(
        "--previous-deploy-ref",
        "--rollback-ref",
        dest="previous_deploy_ref",
        help="Previously approved deploy reference to restore on rollback.",
    )
    rollback.add_argument("--current-deploy-ref", help="Current candidate deploy reference.")
    rollback.add_argument("--incumbent-baseline-ref", help="Incumbent baseline ref used for rollback comparison.")
    rollback.add_argument(
        "--live-influence-state",
        default="canary",
        help="Live influence state for rollback evidence. Defaults to canary.",
    )
    rollback.add_argument(
        "--live-influence-surface",
        default="bounded_high_level_strategy_knobs",
        help="Allowed live influence surface for rollback evidence.",
    )
    rollback.add_argument("--rollout-id", help="Stable rollout ID to record.")

    return parser


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        if args.command == "contract":
            write_output(build_gate_contract(), args.output, stdout)
            return 0

        if args.command == "canary-plan":
            baseline = load_json(args.baseline) if args.baseline is not None else None
            scorecard = load_json(Path(args.scorecard_ref)) if text_present(args.scorecard_ref) else None
            write_output(
                build_canary_readiness_plan(
                    active_world_ref=args.active_world_ref,
                    active_world_status=args.active_world_status,
                    baseline_raw=baseline,
                    baseline_source=str(args.baseline) if args.baseline is not None else None,
                    candidate_id=args.candidate_id,
                    conclusion_records=args.conclusion,
                    conclusion_registry_ref=args.conclusion_registry_ref,
                    conclusion_summary=args.conclusion_summary,
                    construction_acceptance_status=args.construction_acceptance_status,
                    cpu_baseline_ref=args.cpu_baseline_ref,
                    cpu_baseline_status=args.cpu_baseline_status,
                    created_at=args.created_at,
                    deploy_artifact=args.deploy_artifact,
                    deploy_ref=args.deploy_ref,
                    health_gate_ok=args.health_gate_ok,
                    incumbent_baseline_ref=args.incumbent_baseline_ref,
                    live_influence_state=args.live_influence_state,
                    live_influence_surface=args.live_influence_surface,
                    official_deploy_head=args.official_deploy_head,
                    official_deploy_run_id=args.official_deploy_run_id,
                    official_mmo_write_allowed=args.official_mmo_write_allowed,
                    owned_creeps=args.owned_creeps,
                    owned_spawns=args.owned_spawns,
                    paid_compute_allowed=args.paid_compute_allowed,
                    postdeploy_alert=args.postdeploy_alert,
                    postdeploy_alert_artifact=args.postdeploy_alert_artifact,
                    postdeploy_health_gate_artifact=args.postdeploy_health_gate_artifact,
                    postdeploy_summary_artifact=args.postdeploy_summary_artifact,
                    rollback_ref=args.rollback_ref,
                    scorecard_raw=scorecard,
                    scorecard_ref=args.scorecard_ref,
                ),
                args.output,
                stdout,
            )
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
                    incumbent_baseline_ref=args.incumbent_baseline_ref,
                    created_at=args.created_at,
                    live_influence_state=args.live_influence_state,
                    live_influence_surface=args.live_influence_surface,
                    rollout_id=args.rollout_id,
                    pre_source=str(args.pre),
                    post_source=str(args.post),
                    rollback_ref=args.rollback_ref,
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
                    candidate_id=args.candidate_id,
                    created_at=args.created_at,
                    deploy_ref=args.deploy_ref,
                    incumbent_baseline_ref=args.incumbent_baseline_ref,
                    live_influence_state=args.live_influence_state,
                    live_influence_surface=args.live_influence_surface,
                    pre_source=str(args.pre),
                    post_source=str(args.post),
                    rollback_ref=args.rollback_ref,
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
                    incumbent_baseline_ref=args.incumbent_baseline_ref,
                    created_at=args.created_at,
                    live_influence_state=args.live_influence_state,
                    live_influence_surface=args.live_influence_surface,
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
