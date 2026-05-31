#!/usr/bin/env python3
"""Read-modify-write helpers for the RL conclusion registry."""

from __future__ import annotations

import fcntl
import json
import os
import stat
import tempfile
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Sequence


SCHEMA_VERSION = 1
REGISTRY_TYPE = "rl-conclusion-registry"
CONCLUSION_STATUSES = ("OPEN", "STALE", "ACTIONED", "VALIDATING", "CLOSED", "ESCALATED")
ACTIONABLE_STALE_SEVERITIES = ("P0", "P1")
ACTIONABLE_STALE_STATUSES = ("OPEN", "STALE")
ACTIONABLE_STALE_CONCLUSION_THRESHOLD = 10
ACTIONABLE_STALE_CONCLUSION_PREVIEW_LIMIT = 10
STALE_CONCLUSION_AGGREGATE_ROUTING_ISSUE = "#1543"
STALE_CONCLUSION_AGGREGATE_ROUTING_ISSUE_NUMBER = 1543
MIN_STALE_CONCLUSION_TRIAGE_DECISIONS_PER_STEWARD_CYCLE = 3

JsonObject = dict[str, Any]


class ConclusionRegistryError(ValueError):
    """Raised when a conclusion registry update would lose or corrupt records."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        existing_mode = stat.S_IMODE(path.stat().st_mode)
    except FileNotFoundError:
        existing_mode = None
    temp_fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(temp_fd, "w", encoding="utf-8") as handle:
            temp_fd = -1
            handle.write(canonical_json(payload))
        if existing_mode is not None:
            os.chmod(temp_path, existing_mode)
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


@contextmanager
def locked_registry(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(f".{path.name}.lock")
    with lock_path.open("a+", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def load_registry(path: Path) -> JsonObject:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except OSError as error:
        raise ConclusionRegistryError(f"could not read conclusion registry {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise ConclusionRegistryError(f"conclusion registry {path} is not valid JSON: {error}") from error
    if not isinstance(parsed, dict):
        raise ConclusionRegistryError(f"conclusion registry {path} must contain a JSON object")
    return parsed


def normalize_conclusions(value: Any) -> dict[str, JsonObject]:
    if value is None:
        return {}
    if isinstance(value, dict) and "conclusions" in value and "conclusionId" not in value:
        return normalize_conclusions(value.get("conclusions"))

    items: list[tuple[str | None, Any]]
    if isinstance(value, dict):
        items = [(key, item) for key, item in value.items()]
    elif isinstance(value, list):
        items = [(None, item) for item in value]
    else:
        raise ConclusionRegistryError("conclusions must be a list or object keyed by conclusionId")

    records: dict[str, JsonObject] = {}
    for key, item in items:
        if not isinstance(item, dict):
            raise ConclusionRegistryError("each conclusion record must be a JSON object")
        conclusion_id = item.get("conclusionId") if isinstance(item.get("conclusionId"), str) else key
        if not isinstance(conclusion_id, str) or not conclusion_id:
            raise ConclusionRegistryError("each conclusion record must have a non-empty conclusionId")
        record = dict(item)
        record["conclusionId"] = conclusion_id
        if conclusion_id in records:
            raise ConclusionRegistryError(f"duplicate conclusionId {conclusion_id!r} in conclusions payload")
        records[conclusion_id] = record
    return records


def merge_registry_payload(
    existing: JsonObject | None,
    producer_conclusions: Sequence[JsonObject] | JsonObject,
    *,
    owner_cron: str,
    updated_at: str,
    updated_by: str | None = None,
) -> JsonObject:
    if not owner_cron:
        raise ConclusionRegistryError("owner_cron must be non-empty")
    if not updated_at:
        raise ConclusionRegistryError("updated_at must be non-empty")

    existing_payload = existing or {}
    existing_records = normalize_conclusions(existing_payload.get("conclusions"))
    incoming_records = normalize_conclusions(producer_conclusions)

    merged = {
        conclusion_id: record
        for conclusion_id, record in existing_records.items()
        if conclusion_id in incoming_records or record.get("ownerCron") != owner_cron
    }
    new_count = 0
    closed_this_window = 0
    for conclusion_id, incoming in incoming_records.items():
        incoming_owner = incoming.get("ownerCron")
        if isinstance(incoming_owner, str) and incoming_owner != owner_cron:
            raise ConclusionRegistryError(
                f"conclusion {conclusion_id} is owned by {incoming_owner}, not producer {owner_cron}"
            )

        previous = existing_records.get(conclusion_id)
        previous_owner = previous.get("ownerCron") if isinstance(previous, dict) else None
        if previous is not None and previous_owner is not None and previous_owner != owner_cron:
            raise ConclusionRegistryError(
                f"refusing to overwrite conclusion {conclusion_id} owned by {previous_owner!r}"
            )

        if previous is None:
            new_count += 1
        if (
            previous is not None
            and str(previous.get("status", "")).upper() != "CLOSED"
            and str(incoming.get("status", "")).upper() == "CLOSED"
        ):
            closed_this_window += 1

        next_record = dict(incoming)
        next_record["conclusionId"] = conclusion_id
        next_record["ownerCron"] = owner_cron
        next_record.setdefault("lastSeenAt", updated_at)
        merged[conclusion_id] = next_record

    return {
        "schemaVersion": existing_payload.get("schemaVersion", SCHEMA_VERSION),
        "registryType": existing_payload.get("registryType", REGISTRY_TYPE),
        "lastUpdatedAt": updated_at,
        "updatedBy": updated_by or owner_cron,
        "conclusions": merged,
        "summary": summarize_conclusions(
            merged,
            new_count=new_count,
            closed_this_window=closed_this_window,
        ),
    }


def summarize_conclusions(
    records: dict[str, JsonObject],
    *,
    new_count: int = 0,
    closed_this_window: int = 0,
) -> JsonObject:
    status_counts = {status: 0 for status in CONCLUSION_STATUSES}
    counts_by_status = {status: 0 for status in CONCLUSION_STATUSES}
    unknown_count = 0
    for record in records.values():
        status = str(record.get("status", "UNKNOWN")).upper()
        counts_by_status[status] = counts_by_status.get(status, 0) + 1
        if status in status_counts:
            status_counts[status] += 1
        else:
            unknown_count += 1

    return {
        "total": len(records),
        "new": new_count,
        "open": status_counts["OPEN"],
        "actioned": status_counts["ACTIONED"],
        "validating": status_counts["VALIDATING"],
        "closedThisWindow": closed_this_window,
        "staleOrEscalated": status_counts["STALE"] + status_counts["ESCALATED"],
        "countsByStatus": counts_by_status,
        "unknown": unknown_count,
        "actionableIssueGate": high_priority_stale_issue_gate(records),
        "staleConclusionActionPlan": build_stale_conclusion_action_plan(records),
    }


def high_priority_stale_issue_gate(records: dict[str, JsonObject]) -> JsonObject:
    stale_by_severity = {severity: 0 for severity in ACTIONABLE_STALE_SEVERITIES}
    open_by_severity = {severity: 0 for severity in ACTIONABLE_STALE_SEVERITIES}
    unresolved: list[JsonObject] = []

    for record in records.values():
        severity = str(record.get("severity", "")).upper()
        if severity not in ACTIONABLE_STALE_SEVERITIES:
            continue
        status = str(record.get("status", "")).upper()
        if status == "STALE":
            stale_by_severity[severity] += 1
            unresolved.append(record)
        elif status == "OPEN":
            open_by_severity[severity] += 1
            unresolved.append(record)

    stale_count = sum(stale_by_severity.values())
    open_count = sum(open_by_severity.values())
    threshold_exceeded = stale_count > ACTIONABLE_STALE_CONCLUSION_THRESHOLD
    highest_priority_ids = [
        conclusion_id
        for conclusion_id in (
            record.get("conclusionId")
            for record in sorted(unresolved, key=conclusion_gate_priority_key)
        )
        if isinstance(conclusion_id, str) and conclusion_id
    ][:ACTIONABLE_STALE_CONCLUSION_PREVIEW_LIMIT]

    gate: JsonObject = {
        "name": "p0_p1_stale_conclusion_backlog",
        "status": "ACTION_REQUIRED" if threshold_exceeded else "OK",
        "aggregateRoutingIssue": STALE_CONCLUSION_AGGREGATE_ROUTING_ISSUE,
        "aggregateRoutingIssueNumber": STALE_CONCLUSION_AGGREGATE_ROUTING_ISSUE_NUMBER,
        "minimumStaleTransitionsPerStewardCycle": (
            MIN_STALE_CONCLUSION_TRIAGE_DECISIONS_PER_STEWARD_CYCLE
        ),
        "requiredStaleTransition": "STALE -> ACTIONED/CLOSED",
        "threshold": ACTIONABLE_STALE_CONCLUSION_THRESHOLD,
        "thresholdExceeded": threshold_exceeded,
        "staleHighPriorityCount": stale_count,
        "openHighPriorityCount": open_count,
        "staleBySeverity": stale_by_severity,
        "openBySeverity": open_by_severity,
        "highestPriorityConclusionIds": highest_priority_ids,
    }
    if threshold_exceeded:
        gate["recommendedAction"] = (
            "create_or_update_aggregate_rl_conclusion_closure_issue_and_project_evidence"
        )
        gate["evidence"] = (
            f"{stale_count} P0/P1 STALE conclusions exceed threshold "
            f"{ACTIONABLE_STALE_CONCLUSION_THRESHOLD}; steward/checker must route aggregate closure "
            "or escalation before reporting the backlog as background context."
        )
    return gate


def build_stale_conclusion_action_plan(
    registry_or_conclusions: Any,
    *,
    aggregate_issue: str = STALE_CONCLUSION_AGGREGATE_ROUTING_ISSUE,
    aggregate_issue_number: int = STALE_CONCLUSION_AGGREGATE_ROUTING_ISSUE_NUMBER,
    minimum_stale_transitions_per_cycle: int = (
        MIN_STALE_CONCLUSION_TRIAGE_DECISIONS_PER_STEWARD_CYCLE
    ),
    preview_limit: int = ACTIONABLE_STALE_CONCLUSION_PREVIEW_LIMIT,
) -> JsonObject:
    """Build a deterministic steward plan for P0/P1 OPEN or STALE conclusions."""
    if minimum_stale_transitions_per_cycle < 0:
        raise ConclusionRegistryError("minimum_stale_transitions_per_cycle must be non-negative")
    if preview_limit < 0:
        raise ConclusionRegistryError("preview_limit must be non-negative")

    records = normalize_conclusions(registry_or_conclusions)
    candidates = sorted(
        (record for record in records.values() if is_stale_action_plan_candidate(record)),
        key=stale_action_plan_priority_key,
    )

    counts_by_status = {
        status: sum(1 for record in candidates if conclusion_status(record) == status)
        for status in ACTIONABLE_STALE_STATUSES
    }
    counts_by_severity = {
        severity: sum(1 for record in candidates if conclusion_severity(record) == severity)
        for severity in ACTIONABLE_STALE_SEVERITIES
    }
    counts_by_category = dict(
        sorted(Counter(conclusion_category(record) for record in candidates).items())
    )

    grouped_records: dict[str, list[JsonObject]] = {
        "likelySupersededOrStale": [],
        "currentActionableBlockers": [],
    }
    for record in candidates:
        action_record = stale_action_plan_record(record)
        group_name = str(action_record["triageGroup"])
        grouped_records[group_name].append(action_record)

    stale_count = counts_by_status["STALE"]
    target_transitions = min(stale_count, minimum_stale_transitions_per_cycle)

    return {
        "name": "p0_p1_open_stale_conclusion_action_plan",
        "aggregateRoutingIssue": aggregate_issue,
        "aggregateRoutingIssueNumber": aggregate_issue_number,
        "candidateFilter": {
            "statuses": list(ACTIONABLE_STALE_STATUSES),
            "severities": list(ACTIONABLE_STALE_SEVERITIES),
        },
        "totalActionableCount": len(candidates),
        "staleDecisionBacklogCount": stale_count,
        "countsByStatus": counts_by_status,
        "countsBySeverity": counts_by_severity,
        "countsByCategory": counts_by_category,
        "highestPriorityConclusionIds": [
            conclusion_id
            for conclusion_id in (record.get("conclusionId") for record in candidates)
            if isinstance(conclusion_id, str) and conclusion_id
        ][:preview_limit],
        "groups": grouped_records,
        "recommendedNextAction": {
            "action": "triage_stale_conclusions_via_aggregate_routing_issue",
            "routingIssue": aggregate_issue,
            "routingIssueNumber": aggregate_issue_number,
            "minimumStaleTransitionsPerStewardCycle": minimum_stale_transitions_per_cycle,
            "requiredStaleTransition": "STALE -> ACTIONED/CLOSED",
            "targetStaleTransitionsThisCycle": target_transitions,
        },
    }


def is_stale_action_plan_candidate(record: JsonObject) -> bool:
    return (
        conclusion_severity(record) in ACTIONABLE_STALE_SEVERITIES
        and conclusion_status(record) in ACTIONABLE_STALE_STATUSES
    )


def stale_action_plan_record(record: JsonObject) -> JsonObject:
    status = conclusion_status(record)
    severity = conclusion_severity(record)
    category = conclusion_category(record)
    flags = stale_action_plan_evidence_flags(record)
    superseded = "statement_superseded" in flags or "category_superseded" in flags
    likely_stale = superseded or "status_stale" in flags or "category_stale" in flags
    group = "likelySupersededOrStale" if likely_stale else "currentActionableBlockers"
    if superseded:
        disposition = "CLOSE_IF_SUPERSEDED"
    elif likely_stale:
        disposition = "TRIAGE_STALE_TO_ACTIONED_OR_CLOSED"
    elif "required_landing_evidence_present" in flags or "next_verification_present" in flags:
        disposition = "ROUTE_CURRENT_BLOCKER_FOR_EVIDENCE"
    else:
        disposition = "VERIFY_AND_ROUTE_CURRENT_BLOCKER"

    action_record: JsonObject = {
        "conclusionId": str(record.get("conclusionId") or ""),
        "status": status,
        "severity": severity,
        "category": category,
        "triageGroup": group,
        "recommendedDisposition": disposition,
        "evidenceFlags": flags,
    }
    for field in ("lastSeenAt", "requiredLandingEvidence", "nextVerification"):
        value = record.get(field)
        if has_evidence_value(value):
            action_record[field] = value
    linked_issues = normalize_linked_issues(record.get("linkedIssues"))
    if linked_issues:
        action_record["linkedIssues"] = linked_issues
    return action_record


def stale_action_plan_evidence_flags(record: JsonObject) -> list[str]:
    flags: list[str] = []
    status = conclusion_status(record)
    statement = str(record.get("statement") or "")
    category = conclusion_category(record)
    category_upper = category.upper()
    if status == "STALE":
        flags.append("status_stale")
    if "SUPERSEDED" in statement.upper():
        flags.append("statement_superseded")
    if "SUPERSEDED" in category_upper or "OBSOLETE" in category_upper or "DEPRECATED" in category_upper:
        flags.append("category_superseded")
    if "STALE" in category_upper:
        flags.append("category_stale")
    if normalize_linked_issues(record.get("linkedIssues")):
        flags.append("linked_issue_present")
    if has_evidence_value(record.get("requiredLandingEvidence")):
        flags.append("required_landing_evidence_present")
    if has_evidence_value(record.get("nextVerification")):
        flags.append("next_verification_present")
    return flags


def stale_action_plan_priority_key(record: JsonObject) -> tuple[int, int, str, str, str]:
    severity_order = {"P0": 0, "P1": 1}
    status_order = {"STALE": 0, "OPEN": 1}
    return (
        severity_order.get(conclusion_severity(record), 99),
        status_order.get(conclusion_status(record), 99),
        str(record.get("lastSeenAt") or record.get("nextVerification") or ""),
        conclusion_category(record),
        str(record.get("conclusionId") or ""),
    )


def conclusion_status(record: JsonObject) -> str:
    return str(record.get("status", "UNKNOWN")).upper()


def conclusion_severity(record: JsonObject) -> str:
    return str(record.get("severity", "")).upper()


def conclusion_category(record: JsonObject) -> str:
    category = record.get("category")
    if not isinstance(category, str) or not category.strip():
        return "UNCATEGORIZED"
    return category.strip()


def has_evidence_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple, dict)):
        return bool(value)
    return True


def normalize_linked_issues(value: Any) -> list[str]:
    if not has_evidence_value(value):
        return []
    if isinstance(value, list):
        values = value
    else:
        values = [value]
    normalized = [stable_text_value(item) for item in values if has_evidence_value(item)]
    return sorted(dict.fromkeys(item for item in normalized if item))


def stable_text_value(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value)
    return json.dumps(value, ensure_ascii=True, sort_keys=True)


def conclusion_gate_priority_key(record: JsonObject) -> tuple[int, int, str, str]:
    severity_order = {"P0": 0, "P1": 1}
    status_order = {"STALE": 0, "OPEN": 1}
    severity = str(record.get("severity", "")).upper()
    status = str(record.get("status", "")).upper()
    last_seen = str(record.get("lastSeenAt") or record.get("nextVerification") or "")
    conclusion_id = str(record.get("conclusionId") or "")
    return (
        severity_order.get(severity, 99),
        status_order.get(status, 99),
        last_seen,
        conclusion_id,
    )


def merge_registry_file(
    path: Path,
    producer_conclusions: Sequence[JsonObject] | JsonObject,
    *,
    owner_cron: str,
    updated_at: str,
    updated_by: str | None = None,
) -> JsonObject:
    with locked_registry(path):
        merged = merge_registry_payload(
            load_registry(path),
            producer_conclusions,
            owner_cron=owner_cron,
            updated_at=updated_at,
            updated_by=updated_by,
        )
        write_json_atomic(path, merged)
    return merged
