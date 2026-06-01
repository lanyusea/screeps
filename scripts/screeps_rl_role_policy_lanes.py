#!/usr/bin/env python3
"""Shared role-scoped RL policy lane contract for offline/shadow artifacts."""

from __future__ import annotations

import copy
from typing import Any, Sequence


SCHEMA_VERSION = 1
CONTRACT_TYPE = "screeps-rl-role-policy-lane-contract"
LANE_DEFINITION_TYPE = "screeps-rl-role-policy-lane-definition"
ROLE_POLICY_FAMILY_PREFIX = "role."
MIXED_ROLE_REASON_FIELDS = (
    "mixedRolePolicyReason",
    "mixed_role_policy_reason",
    "metaPolicyReason",
    "meta_policy_reason",
    "topLevelMetaPolicyReason",
    "top_level_meta_policy_reason",
    "policyAggregationReason",
    "policy_aggregation_reason",
)

JsonObject = dict[str, Any]


class RolePolicyLaneError(ValueError):
    """Raised when a role-policy lane artifact loses required metadata."""


ROLE_POLICY_LANES: tuple[JsonObject, ...] = (
    {
        "type": LANE_DEFINITION_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "laneId": "role.worker-task",
        "policyFamily": "role.worker-task",
        "rolePolicy": "worker-task",
        "trainingRole": "worker",
        "scope": "worker task and target selection: harvest, transfer, build, repair, upgrade",
        "baseline": {
            "strategyVariantId": "role.worker-task.heuristic-baseline.v1",
            "candidatePolicyId": "role.worker-task.heuristic-baseline.v1",
            "policyFamily": "role.worker-task",
            "rolePolicy": "worker-task",
            "trainingRole": "worker",
            "rolloutStatus": "incumbent",
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        },
        "candidate": {
            "strategyVariantId": "role.worker-task.shadow-candidate.v1",
            "candidatePolicyId": "role.worker-task.shadow-candidate.v1",
            "policyFamily": "role.worker-task",
            "rolePolicy": "worker-task",
            "trainingRole": "worker",
            "rolloutStatus": "shadow",
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        },
    },
    {
        "type": LANE_DEFINITION_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "laneId": "role.source-harvester",
        "policyFamily": "role.source-harvester",
        "rolePolicy": "source-harvester",
        "trainingRole": "source-harvester",
        "scope": (
            "source assignment, harvest positioning, container/link interaction, "
            "and bounded remote-harvest constraints"
        ),
        "baseline": {
            "strategyVariantId": "role.source-harvester.heuristic-baseline.v1",
            "candidatePolicyId": "role.source-harvester.heuristic-baseline.v1",
            "policyFamily": "role.source-harvester",
            "rolePolicy": "source-harvester",
            "trainingRole": "source-harvester",
            "rolloutStatus": "incumbent",
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        },
        "candidate": {
            "strategyVariantId": "role.source-harvester.shadow-candidate.v1",
            "candidatePolicyId": "role.source-harvester.shadow-candidate.v1",
            "policyFamily": "role.source-harvester",
            "rolePolicy": "source-harvester",
            "trainingRole": "source-harvester",
            "rolloutStatus": "shadow",
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        },
    },
    {
        "type": LANE_DEFINITION_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "laneId": "role.defender-micro",
        "policyFamily": "role.defender-micro",
        "rolePolicy": "defender-micro",
        "trainingRole": "defender",
        "scope": (
            "defender and tower-adjacent tactical response: target selection, "
            "engage, retreat, and guard behaviors"
        ),
        "baseline": {
            "strategyVariantId": "role.defender-micro.heuristic-baseline.v1",
            "candidatePolicyId": "role.defender-micro.heuristic-baseline.v1",
            "policyFamily": "role.defender-micro",
            "rolePolicy": "defender-micro",
            "trainingRole": "defender",
            "rolloutStatus": "incumbent",
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        },
        "candidate": {
            "strategyVariantId": "role.defender-micro.shadow-candidate.v1",
            "candidatePolicyId": "role.defender-micro.shadow-candidate.v1",
            "policyFamily": "role.defender-micro",
            "rolePolicy": "defender-micro",
            "trainingRole": "defender",
            "rolloutStatus": "shadow",
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        },
    },
)


def role_policy_lane_definitions() -> list[JsonObject]:
    return [copy.deepcopy(lane) for lane in ROLE_POLICY_LANES]


def role_policy_contract(*, owning_issue: str = "#1585") -> JsonObject:
    return {
        "type": CONTRACT_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "owningIssue": owning_issue,
        "initialLanes": role_policy_lane_definitions(),
        "requiredMetadata": ["policyFamily", "rolePolicy", "trainingRole"],
        "mixedRolePolicyFamiliesRequireReason": True,
        "acceptedMixedRoleReasonFields": list(MIXED_ROLE_REASON_FIELDS),
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "notes": (
            "Top-level construction-priority canary evidence is policyFamily=top.construction; "
            "it is not role-policy completion evidence unless a separate role.* lane scorecard exists."
        ),
    }


def known_lane_by_policy_family() -> dict[str, JsonObject]:
    return {str(lane["policyFamily"]): lane for lane in ROLE_POLICY_LANES}


def is_role_policy_family(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(ROLE_POLICY_FAMILY_PREFIX)


def text_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def first_mapping(raw: JsonObject, keys: Sequence[str]) -> JsonObject | None:
    for key in keys:
        value = raw.get(key)
        if isinstance(value, dict):
            return value
    return None


def explicit_mixed_role_policy_reason(raw: JsonObject | None) -> str | None:
    if not isinstance(raw, dict):
        return None
    for field in MIXED_ROLE_REASON_FIELDS:
        value = text_or_none(raw.get(field))
        if value is not None:
            return value
    for container_key in ("policyLaneContract", "rolePolicyLaneContract", "policyRouting"):
        nested = first_mapping(raw, (container_key,))
        if nested is None:
            continue
        nested_reason = explicit_mixed_role_policy_reason(nested)
        if nested_reason is not None:
            return nested_reason
    return None


def lane_metadata(raw: Any) -> JsonObject:
    if not isinstance(raw, dict):
        return {}
    metadata: JsonObject = {}
    policy_family = text_or_none(raw.get("policyFamily")) or text_or_none(raw.get("policy_family"))
    role_policy = text_or_none(raw.get("rolePolicy")) or text_or_none(raw.get("role_policy"))
    training_role = text_or_none(raw.get("trainingRole")) or text_or_none(raw.get("training_role"))
    if policy_family is not None:
        metadata["policyFamily"] = policy_family
    if role_policy is not None:
        metadata["rolePolicy"] = role_policy
    if training_role is not None:
        metadata["trainingRole"] = training_role
    return metadata


def lane_defaults(policy_family: str) -> JsonObject | None:
    lane = known_lane_by_policy_family().get(policy_family)
    if lane is None:
        return None
    return {
        "policyFamily": lane["policyFamily"],
        "rolePolicy": lane["rolePolicy"],
        "trainingRole": lane["trainingRole"],
    }


def complete_lane_metadata(raw: JsonObject) -> JsonObject:
    metadata = lane_metadata(raw)
    policy_family = text_or_none(metadata.get("policyFamily"))
    defaults = lane_defaults(policy_family) if policy_family else None
    if defaults is not None:
        completed = dict(defaults)
        completed.update(metadata)
        return completed
    return metadata


def validate_role_policy_metadata(raw: Any, context: str) -> None:
    metadata = lane_metadata(raw)
    policy_family = text_or_none(metadata.get("policyFamily"))
    role_policy = text_or_none(metadata.get("rolePolicy"))
    training_role = text_or_none(metadata.get("trainingRole"))
    if not policy_family:
        if role_policy or training_role:
            raise RolePolicyLaneError(f"{context} has rolePolicy/trainingRole but omits policyFamily")
        return
    if not is_role_policy_family(policy_family):
        return
    if not role_policy:
        raise RolePolicyLaneError(f"{context} policyFamily={policy_family} requires rolePolicy")
    if not training_role:
        raise RolePolicyLaneError(f"{context} policyFamily={policy_family} requires trainingRole")
    defaults = lane_defaults(policy_family)
    if defaults is None:
        return
    if role_policy != defaults["rolePolicy"]:
        raise RolePolicyLaneError(
            f"{context} rolePolicy={role_policy} does not match {policy_family} lane "
            f"rolePolicy={defaults['rolePolicy']}"
        )
    if training_role != defaults["trainingRole"]:
        raise RolePolicyLaneError(
            f"{context} trainingRole={training_role} does not match {policy_family} lane "
            f"trainingRole={defaults['trainingRole']}"
        )


def validate_lane_contract(raw: Any, context: str = "role_policy_lanes") -> None:
    if not isinstance(raw, dict):
        raise RolePolicyLaneError(f"{context} must be a JSON object")
    lanes = raw.get("initialLanes")
    if not isinstance(lanes, list) or not lanes:
        raise RolePolicyLaneError(f"{context}.initialLanes must contain role lane definitions")
    seen: set[str] = set()
    for index, lane in enumerate(lanes):
        if not isinstance(lane, dict):
            raise RolePolicyLaneError(f"{context}.initialLanes[{index}] must be a JSON object")
        validate_role_policy_metadata(lane, f"{context}.initialLanes[{index}]")
        policy_family = text_or_none(lane.get("policyFamily"))
        if policy_family is None:
            raise RolePolicyLaneError(f"{context}.initialLanes[{index}].policyFamily is required")
        if policy_family in seen:
            raise RolePolicyLaneError(f"{context}.initialLanes contains duplicate policyFamily={policy_family}")
        seen.add(policy_family)
        for endpoint in ("baseline", "candidate"):
            value = lane.get(endpoint)
            if not isinstance(value, dict):
                raise RolePolicyLaneError(f"{context}.initialLanes[{index}].{endpoint} must be a JSON object")
            validate_role_policy_metadata(value, f"{context}.initialLanes[{index}].{endpoint}")
            for unsafe_field in ("liveEffect", "officialMmoWrites", "officialMmoWritesAllowed"):
                if value.get(unsafe_field) is True:
                    raise RolePolicyLaneError(
                        f"{context}.initialLanes[{index}].{endpoint}.{unsafe_field} must be false"
                    )
    required = set(known_lane_by_policy_family())
    missing = sorted(required - seen)
    if missing:
        raise RolePolicyLaneError(f"{context}.initialLanes missing required role lanes: {', '.join(missing)}")


def validate_role_policy_collection(
    items: Sequence[Any],
    *,
    context: str,
    parent: JsonObject | None = None,
) -> list[str]:
    role_families: set[str] = set()
    for index, item in enumerate(items):
        item_context = f"{context}[{index}]"
        validate_role_policy_metadata(item, item_context)
        metadata = lane_metadata(item)
        policy_family = text_or_none(metadata.get("policyFamily"))
        if is_role_policy_family(policy_family):
            role_families.add(policy_family)
    if len(role_families) > 1 and explicit_mixed_role_policy_reason(parent) is None:
        raise RolePolicyLaneError(
            f"{context} combines multiple role policy families without an explicit meta-policy reason: "
            f"{', '.join(sorted(role_families))}"
        )
    return sorted(role_families)


def summarize_role_policy_collection(items: Sequence[Any], *, parent: JsonObject | None = None) -> JsonObject:
    role_families = []
    role_policies = []
    training_roles = []
    for item in items:
        metadata = lane_metadata(item)
        policy_family = text_or_none(metadata.get("policyFamily"))
        role_policy = text_or_none(metadata.get("rolePolicy"))
        training_role = text_or_none(metadata.get("trainingRole"))
        if is_role_policy_family(policy_family):
            role_families.append(policy_family)
            if role_policy is not None:
                role_policies.append(role_policy)
            if training_role is not None:
                training_roles.append(training_role)
    return {
        "rolePolicyFamilies": sorted(set(role_families)),
        "rolePolicies": sorted(set(role_policies)),
        "trainingRoles": sorted(set(training_roles)),
        "mixedRolePolicyReason": explicit_mixed_role_policy_reason(parent),
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
    }
