#!/usr/bin/env python3
"""Plan offline RL Act-loop follow-up from gameplay or policy findings."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, Sequence, TextIO


PLAN_TYPE = "screeps-rl-act-loop-plan"
BATCH_TYPE = "screeps-rl-act-loop-plan-batch"
SCHEMA_VERSION = 1
CLASSIFICATIONS = (
    "data_quality",
    "scenario_gap",
    "reward_gap",
    "policy_parameterization_gap",
    "runtime_bug",
    "rollout_regression",
)
BLOCKING_DELTA_CLASSIFICATIONS = {"data_quality", "runtime_bug", "rollout_regression"}
REWARD_DECISION_REGISTRY = "docs/ops/rl-reward-decision-registry.md"
REWARD_DECISION_TEMPLATE = "docs/ops/templates/rl-reward-decision.template.json"
EXPERIMENT_CARD_HELPER = "scripts/screeps_rl_experiment_card.py"
SCORECARD_HELPER = "scripts/screeps_rl_scorecard.py"
DEFAULT_SCENARIO_ID = "e1s1-single-room-no-hostile"
MULTI_TIER_SCENARIO_ID = "multi-tier-territory-combat-v0"
UNPROVEN_ONLINE_STATUSES = {"MIXED", "UNPROVEN", "INCONCLUSIVE", "BLOCKED", "BLOCKED_NO_COMPUTE"}

JsonObject = dict[str, Any]

SAFETY_BLOCK: JsonObject = {
    "conservative_actions_only": True,
    "liveEffect": False,
    "officialMmoWrites": False,
    "officialMmoWritesAllowed": False,
    "ood_rejection": True,
}

CONSTRUCTION_PRIORITY_BOUNDS: tuple[JsonObject, ...] = (
    {
        "name": "baseScoreWeight",
        "min": 0,
        "max": 3,
        "step": 0.1,
        "reason": "Preserve incumbent score influence without allowing it to dominate territory-first signals.",
    },
    {
        "name": "territorySignalWeight",
        "min": 0,
        "max": 30,
        "step": 1,
        "reason": "Bound the first gameplay objective for territory expansion and retention.",
    },
    {
        "name": "resourceSignalWeight",
        "min": 0,
        "max": 30,
        "step": 1,
        "reason": "Bound the second gameplay objective after territory is not worse.",
    },
    {
        "name": "killSignalWeight",
        "min": 0,
        "max": 30,
        "step": 1,
        "reason": "Bound the third gameplay objective for hostile pressure response.",
    },
    {
        "name": "riskPenalty",
        "min": 0,
        "max": 30,
        "step": 1,
        "reason": "Keep safety/risk penalties explicit for rollback and scorecard checks.",
    },
)

CLASSIFICATION_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "runtime_bug",
        (
            "exception",
            "traceback",
            "crash",
            "runtime bug",
            "tick-loop",
            "loop exception",
            "uncaught",
            "typeerror",
        ),
    ),
    (
        "rollout_regression",
        (
            "rollout regression",
            "rolled back",
            "rollback",
            "post-rollout",
            "canary regression",
            "deployed candidate regressed",
        ),
    ),
    (
        "data_quality",
        (
            "data quality",
            "missing telemetry",
            "missing metric",
            "no compute",
            "preflight only",
            "malformed",
            "coverage gap",
            "stale artifact",
            "missing source",
        ),
    ),
    (
        "reward_gap",
        (
            "reward",
            "lexicographic",
            "score shaping",
            "reward decision",
            "reward gap",
        ),
    ),
    (
        "scenario_gap",
        (
            "scenario",
            "fixture",
            "single-room",
            "multi-tier",
            "adjacent room",
            "hostile combat",
            "private map",
            "out-of-distribution",
            "training coverage",
        ),
    ),
    (
        "policy_parameterization_gap",
        (
            "policy",
            "parameter",
            "bounds",
            "candidate vector",
            "policy gradient",
            "knob",
            "weight",
            "mixed",
            "unproven",
        ),
    ),
)


class PlannerInputError(ValueError):
    """Raised when a finding cannot be converted into an Act-loop plan."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    ).hexdigest()


def normalize_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def classification_key(value: Any) -> str | None:
    text = text_value(value)
    if not text:
        return None
    normalized = normalize_key(text)
    for classification in CLASSIFICATIONS:
        if normalize_key(classification) == normalized:
            return classification
    return None


def as_dict(value: Any) -> JsonObject:
    return value if isinstance(value, dict) else {}


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def text_value(value: Any) -> str | None:
    if isinstance(value, str):
        stripped = " ".join(value.strip().split())
        return stripped or None
    return None


def format_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return " ".join(value.strip().split())
    if isinstance(value, list):
        return "; ".join(format_value(item) for item in value if format_value(item))
    if isinstance(value, dict):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return str(value)


def value_index(raw: JsonObject) -> dict[str, Any]:
    return {normalize_key(str(key)): value for key, value in raw.items()}


def lookup(raw: JsonObject, aliases: Sequence[str]) -> Any:
    indexed = value_index(raw)
    for alias in aliases:
        key = normalize_key(alias)
        if key in indexed:
            return indexed[key]
    return None


def first_text(raw: JsonObject, aliases: Sequence[str]) -> str | None:
    return text_value(lookup(raw, aliases))


def identifier_text(value: Any) -> str | None:
    if isinstance(value, dict):
        return first_text(
            value,
            (
                "id",
                "artifactId",
                "reportId",
                "decisionId",
                "componentDecisionId",
                "experimentCardId",
                "cardId",
                "trainingRunId",
                "trainingReportId",
                "scorecardId",
                "scorecardArtifact",
                "rolloutId",
                "path",
            ),
        )
    if isinstance(value, (str, int, float)):
        return format_value(value)
    return None


def first_identifier(raw: JsonObject, aliases: Sequence[str]) -> str | None:
    value = lookup(raw, aliases)
    if isinstance(value, (list, tuple)):
        for item in value:
            identifier = identifier_text(item)
            if identifier:
                return identifier
        return None
    return identifier_text(value)


def nested_lookup(raw: JsonObject, paths: Sequence[Sequence[str]]) -> Any:
    for path in paths:
        current: Any = raw
        for key in path:
            if not isinstance(current, dict):
                current = None
                break
            current = lookup(current, (key,))
        if current is not None:
            return current
    return None


def string_list(value: Any) -> list[str]:
    if isinstance(value, str):
        text = text_value(value)
        return [text] if text else []
    if isinstance(value, list):
        return [item for item in (format_value(item) for item in value) if item]
    if isinstance(value, tuple):
        return [item for item in (format_value(item) for item in value) if item]
    return []


def status_key(raw: Any) -> str | None:
    text = text_value(raw)
    return text.upper().replace("-", "_") if text else None


def text_blob(raw: JsonObject) -> str:
    selected: list[str] = []
    for key in (
        "type",
        "artifactType",
        "title",
        "summary",
        "hypothesis",
        "classification",
        "onlineUtilityStatus",
        "status",
        "kpiDeltaObserved",
        "targetArea",
        "expectedKpiMovement",
        "rollbackStopCondition",
        "evidence",
    ):
        selected.append(format_value(lookup(raw, (key,))))
    for nested in (
        as_dict(raw.get("scenarioEvidence")),
        as_dict(raw.get("scenario")),
        as_dict(raw.get("policyDelta")),
        as_dict(raw.get("parameterSurface")),
    ):
        selected.append(format_value(nested))
    return " ".join(item.lower() for item in selected if item)


def infer_classification(raw: JsonObject) -> str:
    explicit = classification_key(lookup(raw, ("classification", "actLoopClassification", "findingClassification")))
    if explicit:
        return explicit

    missing_capabilities = infer_missing_capabilities(raw)
    if missing_capabilities:
        return "scenario_gap"

    blob = text_blob(raw)
    for classification, keywords in CLASSIFICATION_KEYWORDS:
        if any(keyword in blob for keyword in keywords):
            return classification

    if status_key(first_text(raw, ("onlineUtilityStatus", "onlineStatus", "status"))) in UNPROVEN_ONLINE_STATUSES:
        return "policy_parameterization_gap"
    return "data_quality"


def secondary_classifications(raw: JsonObject, primary: str) -> list[str]:
    blob = text_blob(raw)
    statuses = {
        status_key(lookup(raw, aliases))
        for aliases in (
            ("onlineUtilityStatus",),
            ("status",),
            ("rawStatus",),
        )
    }
    inferred: list[str] = []
    if primary != "policy_parameterization_gap" and (
        statuses & UNPROVEN_ONLINE_STATUSES or any(token in blob for token in ("policy", "parameter", "bounds", "candidate"))
    ):
        inferred.append("policy_parameterization_gap")
    if primary != "scenario_gap" and (
        infer_missing_capabilities(raw) or any(token in blob for token in ("scenario", "fixture", "single-room", "multi-tier"))
    ):
        inferred.append("scenario_gap")
    if primary != "reward_gap" and has_reward_signal(raw):
        inferred.append("reward_gap")
    return [item for index, item in enumerate(inferred) if item not in inferred[:index]]


def has_reward_signal(raw: JsonObject) -> bool:
    if classification_key(lookup(raw, ("classification", "actLoopClassification", "findingClassification"))) == "reward_gap":
        return True
    for aliases in (
        ("rewardDecisionId", "reward_decision_id"),
        ("rewardComponent", "reward_component"),
        ("componentId", "component_id"),
    ):
        if first_text(raw, aliases):
            return True
    reward_text = " ".join(
        format_value(lookup(raw, aliases)).lower()
        for aliases in (
            ("title", "summary", "findingTitle"),
            ("hypothesis",),
            ("kpiDeltaObserved",),
            ("targetArea",),
            ("expectedKpiMovement",),
            ("rollbackStopCondition", "rollbackCondition"),
        )
    )
    return any(token in reward_text for token in ("reward", "reward decision", "score shaping"))


def infer_finding_id(raw: JsonObject) -> str:
    explicit = first_text(raw, ("findingId", "finding_id", "reportId", "report_id", "id", "artifactId"))
    if explicit:
        return explicit
    stable = {
        "title": first_text(raw, ("title", "summary")),
        "window": first_text(raw, ("evidenceWindow", "window", "observedWindow")),
        "status": first_text(raw, ("onlineUtilityStatus", "status")),
        "candidate": first_text(raw, ("candidateId", "candidate_id")),
        "incumbent": first_text(raw, ("incumbentId", "incumbent_id", "baselineId")),
    }
    return f"act-finding-{canonical_hash(stable)[:12]}"


def infer_title(raw: JsonObject, finding_id: str) -> str:
    return first_text(raw, ("title", "summary", "findingTitle", "issueTitle")) or f"Act-loop finding {finding_id}"


def infer_source_artifact(raw: JsonObject, source_artifact: str | None) -> str | None:
    return source_artifact or first_text(
        raw,
        (
            "sourceArtifact",
            "source_artifact",
            "sourceReviewArtifact",
            "reviewArtifact",
            "artifact",
            "path",
        ),
    )


def infer_missing_capabilities(raw: JsonObject) -> list[str]:
    candidates: list[str] = []
    for value in (
        lookup(raw, ("missingCapabilities", "missing_capabilities")),
        nested_lookup(raw, (("scenarioEvidence", "missingCapabilities"), ("scenario", "missingCapabilities"))),
    ):
        candidates.extend(string_list(value))

    scenario = as_dict(raw.get("scenario"))
    capabilities = as_dict(scenario.get("capabilities"))
    if capabilities:
        for capability in ("multi_room_capable", "adjacent_room_territory_signal", "hostile_combat_signal"):
            if capabilities.get(capability) is False:
                candidates.append(capability)

    normalized: list[str] = []
    seen: set[str] = set()
    for item in candidates:
        key = item.strip()
        if key and key not in seen:
            normalized.append(key)
            seen.add(key)
    return normalized


def infer_source_scenario_id(raw: JsonObject) -> str | None:
    return first_text(raw, ("scenarioId", "scenario_id")) or text_value(
        nested_lookup(raw, (("scenarioEvidence", "scenarioId"), ("scenario", "scenario_id"), ("scenario", "scenarioId")))
    )


def infer_target_scenario_id(raw: JsonObject) -> str:
    explicit = first_text(raw, ("targetScenarioId", "nextScenarioId", "scenarioDeltaTarget"))
    if explicit:
        return explicit
    missing = infer_missing_capabilities(raw)
    if missing or (infer_source_scenario_id(raw) == DEFAULT_SCENARIO_ID and status_key(raw.get("onlineUtilityStatus")) in UNPROVEN_ONLINE_STATUSES):
        return MULTI_TIER_SCENARIO_ID
    return infer_source_scenario_id(raw) or DEFAULT_SCENARIO_ID


def infer_policy_surface(raw: JsonObject) -> str:
    explicit = first_text(
        raw,
        (
            "parameterSurface",
            "policySurface",
            "policy_surface",
            "strategyFamily",
            "family",
            "targetFamily",
        ),
    )
    if explicit:
        return explicit
    nested = nested_lookup(
        raw,
        (
            ("policyDelta", "parameterSurface"),
            ("policyDelta", "policySurface"),
            ("parameterSurface", "name"),
            ("policy", "target_family"),
        ),
    )
    if text_value(nested):
        return str(nested)
    blob = text_blob(raw)
    if "construction" in blob or "build" in blob:
        return "construction-priority"
    if "expansion" in blob or "reserve" in blob or "remote" in blob:
        return "expansion-remote"
    return "unspecified-policy-surface"


def infer_policy_bounds(raw: JsonObject, surface: str) -> list[JsonObject]:
    raw_bounds = lookup(raw, ("bounds", "parameterBounds", "policyBounds"))
    if raw_bounds is None:
        raw_bounds = nested_lookup(
            raw,
            (
                ("policyDelta", "bounds"),
                ("parameterSurface", "bounds"),
                ("parameterSurface", "parameters"),
                ("policy", "learnable_parameters"),
            ),
        )
    bounds = normalize_bounds(raw_bounds)
    if bounds:
        return bounds
    if surface == "construction-priority":
        return [dict(item) for item in CONSTRUCTION_PRIORITY_BOUNDS]
    return []


def normalize_bounds(raw_bounds: Any) -> list[JsonObject]:
    if isinstance(raw_bounds, dict):
        iterable = raw_bounds.get("parameters") or raw_bounds.get("bounds") or []
    else:
        iterable = raw_bounds
    bounds: list[JsonObject] = []
    for item in as_list(iterable):
        if not isinstance(item, dict):
            continue
        name = first_text(item, ("name", "parameter", "key"))
        if not name:
            continue
        bound: JsonObject = {"name": name}
        for field in ("min", "max", "step"):
            if item.get(field) is not None:
                bound[field] = item[field]
        reason = first_text(item, ("reason", "description", "rationale"))
        if reason:
            bound["reason"] = reason
        bounds.append(bound)
    return bounds


def infer_component_id(raw: JsonObject, title: str) -> str:
    explicit = first_text(raw, ("componentId", "component_id", "rewardComponent", "reward_component"))
    if explicit:
        return slug(explicit)
    surface = infer_policy_surface(raw)
    if surface != "unspecified-policy-surface":
        return f"{slug(surface)}-reward-decision"
    return slug(title)[:80] or "act-loop-reward-decision"


def slug(value: str) -> str:
    rendered = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return rendered or "unknown"


def collect_metric_evidence(raw: JsonObject) -> JsonObject:
    evidence: JsonObject = {}
    for key in (
        "metricsByCategory",
        "metrics",
        "kpiDeltaObserved",
        "advantageTerritory",
        "advantageResources",
        "advantageKills",
        "qualityChecks",
        "quality_checks",
        "blockingReasons",
    ):
        value = lookup(raw, (key,))
        if value not in (None, "", [], {}):
            evidence[key] = value
    return evidence


def build_finding_summary(
    raw: JsonObject,
    *,
    classification: str,
    secondary: Sequence[str],
    finding_id: str,
    title: str,
    source_artifact: str | None,
) -> JsonObject:
    finding: JsonObject = {
        "id": finding_id,
        "title": title,
        "classification": classification,
        "secondaryClassifications": list(secondary),
    }
    for output_key, aliases in (
        ("sourceArtifact", ("sourceArtifact", "source_artifact", "sourceReviewArtifact", "reviewArtifact", "artifact")),
        ("evidenceWindow", ("evidenceWindow", "evidence_window", "window", "observedWindow")),
        ("onlineUtilityStatus", ("onlineUtilityStatus", "onlineStatus", "status", "rawStatus")),
        ("candidateId", ("candidateId", "candidate_id")),
        ("incumbentId", ("incumbentId", "incumbent_id", "baselineId", "baseline_id")),
        ("hypothesis", ("hypothesis",)),
    ):
        value = first_text(raw, aliases)
        if value:
            finding[output_key] = value
    if source_artifact:
        finding["sourceArtifact"] = source_artifact
    missing_capabilities = infer_missing_capabilities(raw)
    if missing_capabilities:
        finding["missingCapabilities"] = missing_capabilities
    metric_evidence = collect_metric_evidence(raw)
    if metric_evidence:
        finding["metricEvidence"] = metric_evidence
    return finding


def has_delta_blocker(classification: str, secondary: Sequence[str]) -> bool:
    return classification in BLOCKING_DELTA_CLASSIFICATIONS or any(
        item in BLOCKING_DELTA_CLASSIFICATIONS for item in secondary
    )


def needs_reward_decision(classification: str, secondary: Sequence[str]) -> bool:
    if has_delta_blocker(classification, secondary):
        return False
    return classification == "reward_gap" or "reward_gap" in secondary


def needs_scenario_delta(classification: str, secondary: Sequence[str], raw: JsonObject) -> bool:
    if has_delta_blocker(classification, secondary):
        return False
    return classification == "scenario_gap" or "scenario_gap" in secondary or bool(infer_missing_capabilities(raw))


def needs_policy_delta(classification: str, secondary: Sequence[str], raw: JsonObject) -> bool:
    if has_delta_blocker(classification, secondary):
        return False
    status = status_key(first_text(raw, ("onlineUtilityStatus", "status", "rawStatus")))
    return (
        classification == "policy_parameterization_gap"
        or "policy_parameterization_gap" in secondary
        or status in UNPROVEN_ONLINE_STATUSES
    )


def build_reward_decision(raw: JsonObject, *, finding: JsonObject, title: str) -> JsonObject | None:
    component_id = infer_component_id(raw, title)
    hypothesis = first_text(raw, ("hypothesis",)) or (
        "Reward shaping may not currently distinguish the observed gameplay outcome; capture it as a proposed "
        "GitHub-managed reward decision before it can affect training."
    )
    return {
        "action": "create_or_update_reward_decision_record",
        "decisionRecordStyle": "#907-style",
        "registry": REWARD_DECISION_REGISTRY,
        "template": REWARD_DECISION_TEMPLATE,
        "status": "PROPOSED",
        "componentId": component_id,
        "sourceFindingId": finding["id"],
        "sourceFindingClassification": finding["classification"],
        "hypothesis": hypothesis,
        "metricEvidence": collect_metric_evidence(raw),
        "validationWindow": first_text(raw, ("evidenceWindow", "validationWindow", "observedWindow"))
        or "TBD by steward before approval",
        "rollbackCondition": first_text(raw, ("rollbackStopCondition", "rollbackCondition", "rollback_conditions"))
        or "Reject or roll back if safety, reliability, territory, resources, or scorecard dimensions regress.",
        "requiredFields": [
            "metric evidence",
            "hypothesis",
            "validation window",
            "rollback condition",
            "candidate linkage",
        ],
        "safety": dict(SAFETY_BLOCK),
    }


def build_scenario_delta(raw: JsonObject, *, finding: JsonObject) -> JsonObject | None:
    source_scenario_id = infer_source_scenario_id(raw)
    target_scenario_id = infer_target_scenario_id(raw)
    missing_capabilities = infer_missing_capabilities(raw)
    required_capabilities = missing_capabilities or [
        "multi_room_capable",
        "adjacent_room_territory_signal",
        "hostile_combat_signal",
    ]
    return {
        "action": "add_or_select_private_training_scenario",
        "sourceScenarioId": source_scenario_id,
        "targetScenarioId": target_scenario_id,
        "sourceFindingId": finding["id"],
        "missingCapabilities": missing_capabilities,
        "requiredCapabilities": required_capabilities,
        "routing": "experiment_card_delta",
        "constructionIssueIfMissing": "create bounded scenario-fixture construction issue instead of prose-only recommendation",
        "privateOnly": True,
        "shadowOnly": True,
        "safety": dict(SAFETY_BLOCK),
    }


def build_policy_delta(raw: JsonObject, *, finding: JsonObject) -> JsonObject | None:
    surface = infer_policy_surface(raw)
    bounds = infer_policy_bounds(raw, surface)
    candidate_id = first_text(raw, ("candidatePolicyId", "candidateId", "candidate_id", "strategyVariantId"))
    delta: JsonObject = {
        "action": "bound_policy_parameter_surface",
        "parameterSurface": surface,
        "sourceFindingId": finding["id"],
        "bounds": bounds,
        "boundsStatus": "present" if bounds else "missing",
        "routing": "experiment_card_delta",
        "shadowOnly": True,
        "safety": dict(SAFETY_BLOCK),
    }
    if candidate_id:
        delta["candidatePolicyId"] = candidate_id
    return delta


def build_experiment_card_delta(
    raw: JsonObject,
    *,
    finding: JsonObject,
    reward_decision: JsonObject | None,
    scenario_delta: JsonObject | None,
    policy_delta: JsonObject | None,
) -> JsonObject | None:
    if reward_decision is None and scenario_delta is None and policy_delta is None:
        return None
    training_approach = first_text(raw, ("trainingApproach", "training_approach"))
    if not training_approach:
        training_approach = "policy_gradient" if policy_delta is not None else "bandit"
    dataset_run_id = first_text(raw, ("datasetRunId", "dataset_run_id")) or "TBD-by-training-steward"
    target_scenario_id = (
        text_value(as_dict(scenario_delta).get("targetScenarioId"))
        if scenario_delta is not None
        else infer_source_scenario_id(raw) or DEFAULT_SCENARIO_ID
    )
    deltas: JsonObject = {}
    if reward_decision is not None:
        deltas["rewardDecision"] = {
            "componentId": reward_decision["componentId"],
            "status": reward_decision["status"],
            "registry": reward_decision["registry"],
        }
    if scenario_delta is not None:
        deltas["scenario"] = {
            "targetScenarioId": scenario_delta["targetScenarioId"],
            "requiredCapabilities": scenario_delta["requiredCapabilities"],
        }
    if policy_delta is not None:
        deltas["policy"] = {
            "parameterSurface": policy_delta["parameterSurface"],
            "bounds": policy_delta["bounds"],
        }
        if "candidatePolicyId" in policy_delta:
            deltas["policy"]["candidatePolicyId"] = policy_delta["candidatePolicyId"]

    return {
        "action": "create_or_update_experiment_card_delta",
        "cardHelper": EXPERIMENT_CARD_HELPER,
        "scorecardHelper": SCORECARD_HELPER,
        "sourceFindingId": finding["id"],
        "datasetRunId": dataset_run_id,
        "trainingApproach": training_approach,
        "scenarioId": target_scenario_id,
        "status": "shadow",
        "deltas": deltas,
        "requiredValidation": [
            "validate generated experiment card",
            "run offline/private training only",
            "produce #924-compatible scorecard before rollout claims",
        ],
        "safety": dict(SAFETY_BLOCK),
    }


def feedback_link_state(identifier: str | None, *, planned: bool, planned_id: str | None = None) -> JsonObject:
    if identifier:
        return {"state": "linked", "id": identifier}
    if planned:
        item: JsonObject = {"state": "planned"}
        if planned_id:
            item["plannedId"] = planned_id
        return item
    return {"state": "missing"}


def build_feedback_state(
    raw: JsonObject,
    *,
    finding: JsonObject,
    reward_decision: JsonObject | None,
    card_delta: JsonObject | None,
) -> JsonObject:
    reward_decision_id = first_identifier(
        raw,
        (
            "rewardDecisionId",
            "reward_decision_id",
            "rewardDecisionIds",
            "decisionId",
            "decision_id",
            "decisionIds",
            "componentDecisionId",
        ),
    )
    experiment_card_id = first_identifier(
        raw,
        ("experimentCardId", "experiment_card_id", "experimentCardIds", "cardId", "card_id", "cardIds"),
    )
    training_run_id = first_identifier(
        raw,
        ("trainingRunId", "training_run_id", "trainingReportId", "trainingReportIds", "trainingRunIds"),
    )
    scorecard_id = first_identifier(
        raw,
        ("scorecardId", "scorecard_id", "scorecardArtifact", "scorecard", "scorecardIds", "scorecards"),
    )
    rollout_id = first_identifier(raw, ("rolloutId", "rollout_id", "rolloutIds"))

    planned_decision_id = text_value(as_dict(reward_decision).get("componentId")) or f"act-decision:{finding['id']}"
    decision_state = feedback_link_state(
        reward_decision_id,
        planned=reward_decision is not None or card_delta is not None,
        planned_id=planned_decision_id,
    )
    card_state = feedback_link_state(
        experiment_card_id,
        planned=card_delta is not None,
        planned_id=text_value(as_dict(card_delta).get("datasetRunId")),
    )
    training_state = feedback_link_state(training_run_id, planned=False)
    scorecard_state = feedback_link_state(scorecard_id, planned=False)
    rollout_state = feedback_link_state(rollout_id, planned=False)

    return {
        "finding": {
            "state": "observed",
            "id": finding["id"],
            "classification": finding["classification"],
            "sourceArtifact": finding.get("sourceArtifact"),
        },
        "decision": decision_state,
        "experimentCard": card_state,
        "training": training_state,
        "scorecard": scorecard_state,
        "rolloutFeedback": rollout_state,
    }


def plan_blocking_reasons(
    *,
    classification: str,
    reward_decision: JsonObject | None,
    policy_delta: JsonObject | None,
    card_delta: JsonObject | None,
) -> list[str]:
    reasons: list[str] = []
    if classification == "data_quality":
        reasons.append("data quality finding must be resolved or converted to evidence before training changes")
    if classification == "runtime_bug":
        reasons.append("runtime bug must route to a construction issue before reward/scenario/policy iteration")
    if classification == "rollout_regression":
        reasons.append("rollout regression must preserve rollback evidence before the next training card")
    if reward_decision is not None:
        reasons.append("reward changes require a GitHub-managed #907-style decision record before training use")
    if policy_delta is not None and not as_list(policy_delta.get("bounds")):
        reasons.append("policy parameterization change is missing named bounds")
    if card_delta is None and classification not in {"data_quality", "runtime_bug", "rollout_regression"}:
        reasons.append("finding did not produce an experiment-card delta")
    return reasons


def build_plan(raw: JsonObject, *, source_artifact: str | None = None) -> JsonObject:
    if not isinstance(raw, dict):
        raise PlannerInputError("finding must be a JSON object")
    classification = infer_classification(raw)
    secondary = secondary_classifications(raw, classification)
    finding_id = infer_finding_id(raw)
    title = infer_title(raw, finding_id)
    resolved_source_artifact = infer_source_artifact(raw, source_artifact)
    finding = build_finding_summary(
        raw,
        classification=classification,
        secondary=secondary,
        finding_id=finding_id,
        title=title,
        source_artifact=resolved_source_artifact,
    )

    reward_decision = (
        build_reward_decision(raw, finding=finding, title=title)
        if needs_reward_decision(classification, secondary)
        else None
    )
    scenario_delta = (
        build_scenario_delta(raw, finding=finding)
        if needs_scenario_delta(classification, secondary, raw)
        else None
    )
    policy_delta = (
        build_policy_delta(raw, finding=finding)
        if needs_policy_delta(classification, secondary, raw)
        else None
    )
    card_policy_delta = (
        policy_delta
        if policy_delta is not None and as_list(policy_delta.get("bounds"))
        else None
    )
    card_delta = build_experiment_card_delta(
        raw,
        finding=finding,
        reward_decision=reward_decision,
        scenario_delta=scenario_delta,
        policy_delta=card_policy_delta,
    )
    blocking_reasons = plan_blocking_reasons(
        classification=classification,
        reward_decision=reward_decision,
        policy_delta=policy_delta,
        card_delta=card_delta,
    )
    plan_id = f"act-plan-{canonical_hash({'finding': finding, 'classification': classification})[:12]}"
    status = "ACT_DELTA_READY" if card_delta is not None else "ROUTE_REQUIRED"

    return {
        "type": PLAN_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "planId": plan_id,
        "decision": "act_loop_planned",
        "status": status,
        "finding": finding,
        "nextRewardDecision": reward_decision,
        "nextScenarioDelta": scenario_delta,
        "nextPolicyDelta": policy_delta,
        "nextExperimentCardDelta": card_delta,
        "feedbackIngestion": build_feedback_state(
            raw,
            finding=finding,
            reward_decision=reward_decision,
            card_delta=card_delta,
        ),
        "blockingReasons": blocking_reasons,
        "safety": dict(SAFETY_BLOCK),
    }


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise PlannerInputError(f"input file not found: {path}") from error
    except json.JSONDecodeError as error:
        raise PlannerInputError(f"invalid JSON in {path}: {error}") from error


def raw_findings(document: Any) -> tuple[list[JsonObject], JsonObject]:
    if isinstance(document, list):
        findings = document
        metadata: JsonObject = {}
    elif isinstance(document, dict):
        metadata = document
        if isinstance(document.get("findings"), list):
            findings = document["findings"]
        else:
            findings = [document]
    else:
        raise PlannerInputError("input must be a JSON object, JSON array, or object with findings[]")

    result: list[JsonObject] = []
    for index, item in enumerate(findings, start=1):
        if not isinstance(item, dict):
            raise PlannerInputError(f"finding {index}: expected object")
        result.append(item)
    if not result:
        raise PlannerInputError("findings array is empty")
    return result, metadata


def build_plans(document: Any, *, source_artifact: str | None = None) -> JsonObject:
    findings, metadata = raw_findings(document)
    metadata_source = source_artifact or first_text(
        metadata,
        ("sourceArtifact", "source_artifact", "sourceReviewArtifact", "reviewArtifact", "artifact"),
    )
    plans = [build_plan(item, source_artifact=metadata_source) for item in findings]
    if len(plans) == 1:
        return plans[0]
    return {
        "type": BATCH_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "decision": "act_loop_planned",
        "status": "ACT_DELTA_READY" if any(plan.get("nextExperimentCardDelta") for plan in plans) else "ROUTE_REQUIRED",
        "plans": plans,
        "blockingReasons": sorted(
            {
                reason
                for plan in plans
                for reason in as_list(plan.get("blockingReasons"))
                if isinstance(reason, str)
            }
        ),
    }


def write_json_atomic(path: Path, payload: Any) -> None:
    write_text_atomic(path, canonical_json(payload))


def write_text_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(temp_fd, "w", encoding="utf-8") as handle:
            temp_fd = -1
            handle.write(content)
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


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Plan deterministic offline Act-loop deltas from policy advantage or gameplay findings."
    )
    parser.add_argument("input_json", type=Path, help="finding JSON, policy-advantage JSON, or object with findings[]")
    parser.add_argument("--source-artifact", help="repo-relative source artifact path to attach to each finding")
    parser.add_argument("--output", type=Path, help="write the plan JSON to this path instead of stdout")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None, *, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    try:
        plan = build_plans(load_json(args.input_json), source_artifact=args.source_artifact)
    except PlannerInputError as error:
        print(f"error: {error}", file=stderr)
        return 1
    except OSError as error:
        print(f"error: I/O failure: {error}", file=stderr)
        return 1

    try:
        rendered = canonical_json(plan)
    except (TypeError, ValueError) as error:
        print(f"error: failed to serialize plan JSON: {error}", file=stderr)
        return 1

    try:
        if args.output:
            write_text_atomic(args.output, rendered)
        else:
            stdout.write(rendered)
        return 0
    except OSError as error:
        print(f"error: I/O failure: {error}", file=stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
