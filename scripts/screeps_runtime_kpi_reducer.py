#!/usr/bin/env python3
"""Reduce Screeps #runtime-summary lines into Gameplay Evolution KPIs."""

from __future__ import annotations

import argparse
import html
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, TextIO


RUNTIME_SUMMARY_PREFIX = "#runtime-summary "
REPORT_TYPE = "runtime-kpi-report"
SCHEMA_VERSION = 1

OBSERVED = "observed"
NOT_INSTRUMENTED = "not instrumented"
NOT_OBSERVED = "not observed"
CPU_BUCKET_LOW_THRESHOLD = 1_000
CPU_BUCKET_CRITICAL_THRESHOLD = 100

CONTROLLER_FIELDS = ("level", "progress", "progressTotal", "ticksToDowngrade")
RESOURCE_FIELDS = ("storedEnergy", "workerCarriedEnergy", "harvestedThisTick", "droppedEnergy", "sourceCount")
RESOURCE_EVENT_FIELDS = ("harvestedEnergy", "transferredEnergy")
COMBAT_FIELDS = ("hostileCreepCount", "hostileStructureCount")
COMBAT_EVENT_FIELDS = ("attackCount", "attackDamage", "objectDestroyedCount", "creepDestroyedCount")
ROOM_LEVEL_FIELDS = (
    "pendingBuildProgress",
    "buildCarriedEnergy",
    "constructionSiteCount",
    "constructionDeadlockTicks",
    "extensionCount",
    "extensionCapacityContribution",
    "pathFindingFailures",
    "destinationBlocked",
    "tripEnergyMean",
    "tripEnergyMin",
    "cpuUsed",
    "cpuBucket",
    "rclLevel",
    "storedEnergy",
)


JsonObject = dict[str, Any]


@dataclass
class SectionState:
    first: dict[str, int | float | None] | None = None
    latest: dict[str, int | float | None] | None = None


@dataclass
class RoomState:
    controller: SectionState = field(default_factory=SectionState)
    resources: SectionState = field(default_factory=SectionState)
    combat: SectionState = field(default_factory=SectionState)
    room_metrics: SectionState = field(default_factory=SectionState)
    construction_activity_first: JsonObject | None = None
    construction_activity_latest: JsonObject | None = None
    resource_events: dict[str, int | float] = field(default_factory=lambda: zero_totals(RESOURCE_EVENT_FIELDS))
    combat_events: dict[str, int | float] = field(default_factory=lambda: zero_totals(COMBAT_EVENT_FIELDS))
    resource_event_seen: bool = False
    combat_event_seen: bool = False


@dataclass
class ReductionState:
    line_count: int = 0
    runtime_summary_count: int = 0
    malformed_runtime_summary_count: int = 0
    ignored_line_count: int = 0
    first_tick: int | float | None = None
    latest_tick: int | float | None = None
    first_rooms: set[str] | None = None
    latest_rooms: set[str] | None = None
    rooms_seen: bool = False
    rooms: dict[str, RoomState] = field(default_factory=dict)


def zero_totals(fields: Iterable[str]) -> dict[str, int | float]:
    return {field_name: 0 for field_name in fields}


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def clean_numeric_section(section: Any, fields: tuple[str, ...]) -> dict[str, int | float | None] | None:
    if not isinstance(section, dict):
        return None

    values = {field_name: section.get(field_name) if is_number(section.get(field_name)) else None for field_name in fields}
    if all(value is None for value in values.values()):
        return None

    return values


def clean_room_level_metrics(room: dict[str, Any]) -> dict[str, int | float | None] | None:
    resources = room.get("resources") if isinstance(room.get("resources"), dict) else {}
    productive = resources.get("productiveEnergy") if isinstance(resources.get("productiveEnergy"), dict) else {}
    controller = room.get("controller") if isinstance(room.get("controller"), dict) else {}
    structures = room.get("structures") if isinstance(room.get("structures"), dict) else {}
    behavior = room.get("behavior") if isinstance(room.get("behavior"), dict) else {}
    behavior_totals = behavior.get("totals") if isinstance(behavior.get("totals"), dict) else {}
    worker_load_efficiency = room.get("workerLoadEfficiency") if isinstance(room.get("workerLoadEfficiency"), dict) else {}
    values = {
        "pendingBuildProgress": first_number(room, resources, productive, key="pendingBuildProgress"),
        "buildCarriedEnergy": first_number(room, resources, productive, key="buildCarriedEnergy"),
        "constructionSiteCount": first_number(room, productive, key="constructionSiteCount"),
        "constructionDeadlockTicks": first_number(room, productive, key="constructionDeadlockTicks"),
        "extensionCount": first_number(room, structures, key="extensionCount"),
        "extensionCapacityContribution": first_number(room, structures, key="extensionCapacityContribution"),
        "pathFindingFailures": first_number(room, behavior, behavior_totals, key="pathFindingFailures"),
        "destinationBlocked": first_number(room, behavior, behavior_totals, key="destinationBlocked"),
        "tripEnergyMean": first_number(room, worker_load_efficiency, key="tripEnergyMean"),
        "tripEnergyMin": first_number(room, worker_load_efficiency, key="tripEnergyMin"),
        "cpuUsed": room.get("cpuUsed") if is_number(room.get("cpuUsed")) else None,
        "cpuBucket": room.get("cpuBucket") if is_number(room.get("cpuBucket")) else None,
        "rclLevel": first_number(room, controller, key="rclLevel") or (controller.get("level") if is_number(controller.get("level")) else None),
        "storedEnergy": first_number(room, resources, key="storedEnergy"),
    }
    if all(value is None for value in values.values()):
        return None
    return values


def clean_construction_activity(room: dict[str, Any]) -> JsonObject | None:
    resources = room.get("resources") if isinstance(room.get("resources"), dict) else {}
    productive = resources.get("productiveEnergy") if isinstance(resources.get("productiveEnergy"), dict) else {}
    cpu = room.get("cpu") if isinstance(room.get("cpu"), dict) else {}
    explicit = room.get("constructionActivity")
    if not isinstance(explicit, dict):
        explicit = productive.get("constructionActivity")
    if isinstance(explicit, dict):
        state = text_value(explicit.get("state"))
        reason = text_value(explicit.get("reason"))
        if state is not None and reason is not None:
            return normalize_construction_activity(explicit, room, productive, state, reason)

    construction_site_count = first_number(room, productive, key="constructionSiteCount")
    pending_build_progress = first_number(room, resources, productive, key="pendingBuildProgress")
    build_carried_energy = first_number(room, resources, productive, key="buildCarriedEnergy")
    build_progress = first_number(room, productive, resources.get("events", {}) if isinstance(resources.get("events"), dict) else {}, key="builtProgress")
    build_blocked_reason = text_value(room.get("buildBlockedReason")) or text_value(productive.get("buildBlockedReason"))
    worker_assignment_evidence_unavailable_reason = text_value(
        room.get("workerAssignmentEvidenceUnavailableReason")
    ) or text_value(productive.get("workerAssignmentEvidenceUnavailableReason"))
    worker_assignment_blocked_detail = text_value(room.get("workerAssignmentBlockedDetail")) or text_value(
        productive.get("workerAssignmentBlockedDetail")
    )
    cpu_pressure = (
        text_value(room.get("cpuPressure"))
        or text_value(productive.get("cpuPressure"))
        or text_value(cpu.get("pressure"))
        or text_value(room.get("pressure"))
    )
    cpu_reasons = first_text_list(room, productive, cpu, key="cpuReasons") or first_text_list(
        cpu, room, productive, key="reasons"
    )
    cpu_bucket = first_number(room, cpu, key="cpuBucket")
    if cpu_bucket is None:
        cpu_bucket = first_number(cpu, room, key="bucket")
    has_construction_backlog = any(
        (value or 0) > 0
        for value in (construction_site_count, pending_build_progress, build_carried_energy, build_progress)
    )
    if cpu_bucket is not None and cpu_bucket < CPU_BUCKET_LOW_THRESHOLD:
        cpu_pressure = cpu_pressure or ("critical" if cpu_bucket <= CPU_BUCKET_CRITICAL_THRESHOLD else "degraded")
        if not cpu_reasons:
            cpu_reasons = ["criticalBucket" if cpu_bucket <= CPU_BUCKET_CRITICAL_THRESHOLD else "lowBucket"]
    suppressed_reason = fallback_construction_suppressed_reason(
        build_blocked_reason,
        worker_assignment_blocked_detail,
        cpu_pressure,
        cpu_reasons,
        has_construction_backlog,
    )
    if all(
        value is None
        for value in (construction_site_count, pending_build_progress, build_carried_energy, build_progress)
    ) and build_blocked_reason is None and suppressed_reason is None:
        return None

    if (build_progress or 0) > 0:
        state = "active"
        reason = "build_progress_observed"
    elif (build_carried_energy or 0) > 0:
        state = "active"
        reason = "build_energy_carried"
    elif suppressed_reason is not None:
        state = "candidate_suppressed"
        reason = suppressed_reason
    elif (construction_site_count or 0) > 0 or (pending_build_progress or 0) > 0:
        state = "active"
        reason = "site_backlog_visible"
    elif build_blocked_reason == "no_construction_sites":
        state = "no_viable_candidate"
        reason = "no_viable_candidate"
    else:
        return None

    return normalize_construction_activity(
        {
            "state": state,
            "accepted": state != "no_viable_candidate",
            "reason": reason,
            "buildProgress": build_progress,
            **({"buildBlockedReason": build_blocked_reason} if build_blocked_reason is not None else {}),
            **(
                {"workerAssignmentEvidenceUnavailableReason": worker_assignment_evidence_unavailable_reason}
                if worker_assignment_evidence_unavailable_reason is not None
                else {}
            ),
            **(
                {"workerAssignmentBlockedDetail": worker_assignment_blocked_detail}
                if worker_assignment_blocked_detail is not None
                else {}
            ),
            **({"cpuPressure": cpu_pressure} if cpu_pressure is not None else {}),
            **({"cpuReasons": cpu_reasons} if cpu_reasons else {}),
        },
        room,
        productive,
        state,
        reason,
    )


def normalize_construction_activity(
    activity: JsonObject,
    room: dict[str, Any],
    productive: dict[str, Any],
    state: str,
    reason: str,
) -> JsonObject:
    candidate = activity.get("candidate")
    normalized: JsonObject = {
        "state": state,
        "accepted": bool(activity.get("accepted")) if isinstance(activity.get("accepted"), bool) else state != "no_viable_candidate",
        "reason": reason,
        "constructionSiteCount": first_number(activity, room, productive, key="constructionSiteCount"),
        "pendingBuildProgress": first_number(activity, room, productive, key="pendingBuildProgress"),
        "buildCarriedEnergy": first_number(activity, room, productive, key="buildCarriedEnergy"),
        "buildProgress": first_number(activity, productive, key="buildProgress"),
    }
    for key in (
        "buildBlockedReason",
        "workerAssignmentBlockedDetail",
        "workerAssignmentEvidenceAvailable",
        "workerAssignmentEvidenceUnavailableReason",
        "cpuPressure",
    ):
        value = activity.get(key)
        if isinstance(value, (str, bool)) and value != "":
            normalized[key] = value
    cpu_reasons = activity.get("cpuReasons")
    if isinstance(cpu_reasons, list):
        normalized_cpu_reasons = [item for item in (text_value(value) for value in cpu_reasons) if item is not None]
        if normalized_cpu_reasons:
            normalized["cpuReasons"] = normalized_cpu_reasons
    if isinstance(candidate, dict):
        normalized_candidate = {
            key: candidate[key]
            for key in ("buildItem", "room", "score", "urgency", "policyAction")
            if key in candidate
        }
        if normalized_candidate:
            normalized["candidate"] = normalized_candidate
    return normalized


def text_value(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def first_text_list(*sections: dict[str, Any], key: str) -> list[str]:
    for section in sections:
        value = section.get(key)
        if not isinstance(value, list):
            continue
        result = [item for item in (text_value(item) for item in value) if item is not None]
        if result:
            return result
    return []


def fallback_construction_suppressed_reason(
    build_blocked_reason: str | None,
    worker_assignment_blocked_detail: str | None,
    cpu_pressure: str | None,
    cpu_reasons: list[str],
    has_construction_backlog: bool,
) -> str | None:
    if has_construction_backlog:
        if any(reason in {"lowBucket", "criticalBucket"} for reason in cpu_reasons):
            return "cpu_shed"
        if cpu_pressure is not None and cpu_pressure != "normal":
            return "cpu_shed"
    if worker_assignment_blocked_detail == "spawn_reserving_energy":
        return "spawn_reserving_energy"
    if build_blocked_reason in {"energy_buffer_blocked", "worker_assignment_gap"}:
        return build_blocked_reason
    if worker_assignment_blocked_detail is not None:
        return "worker_assignment_gap"
    return None


def first_number(*sections: dict[str, Any], key: str) -> int | float | None:
    for section in sections:
        value = section.get(key)
        if is_number(value):
            return value
    return None


def add_events(target: dict[str, int | float], events: Any, fields: tuple[str, ...]) -> bool:
    if not isinstance(events, dict):
        return False

    seen = False
    for field_name in fields:
        value = events.get(field_name)
        if is_number(value):
            target[field_name] += value
            seen = True

    return seen


def update_section(state: SectionState, values: dict[str, int | float | None] | None) -> None:
    if values is None:
        state.latest = None
        return

    if state.first is None:
        state.first = dict(values)
    state.latest = dict(values)


def update_construction_activity(state: RoomState, activity: JsonObject | None) -> None:
    if activity is None:
        state.construction_activity_latest = None
        return

    if state.construction_activity_first is None:
        state.construction_activity_first = dict(activity)
    state.construction_activity_latest = dict(activity)


def parse_runtime_summary_line(line: str) -> tuple[JsonObject | None, bool]:
    """Return (payload, malformed_prefixed_line)."""
    if RUNTIME_SUMMARY_PREFIX in line:
        payload_text = line.split(RUNTIME_SUMMARY_PREFIX, 1)[1].strip()
        saw_prefix = True
    else:
        payload_text = line.strip()
        saw_prefix = False

    if not payload_text:
        return None, saw_prefix

    try:
        payload = json.loads(html.unescape(payload_text))
    except json.JSONDecodeError:
        return None, saw_prefix

    if isinstance(payload, dict) and payload.get("type") == "runtime-summary":
        return payload, False

    return None, False


def reduce_runtime_kpis(lines: Iterable[str]) -> JsonObject:
    state = ReductionState()

    for line in lines:
        state.line_count += 1
        payload, malformed = parse_runtime_summary_line(line)
        if malformed:
            state.malformed_runtime_summary_count += 1
            state.ignored_line_count += 1
            continue
        if payload is None:
            state.ignored_line_count += 1
            continue

        state.runtime_summary_count += 1
        tick = payload.get("tick")
        if is_number(tick):
            if state.first_tick is None:
                state.first_tick = tick
            state.latest_tick = tick

        rooms = payload.get("rooms")
        if isinstance(rooms, list):
            state.rooms_seen = True
            summary_rooms: set[str] = set()
            for room in rooms:
                if not isinstance(room, dict):
                    continue
                room_name = room.get("roomName")
                if not isinstance(room_name, str) or not room_name:
                    continue

                summary_rooms.add(room_name)
                room_state = state.rooms.setdefault(room_name, RoomState())

                room_metrics = clean_room_level_metrics(room)
                update_section(room_state.room_metrics, room_metrics)

                construction_activity = clean_construction_activity(room)
                update_construction_activity(room_state, construction_activity)

                controller = clean_numeric_section(room.get("controller"), CONTROLLER_FIELDS)
                update_section(room_state.controller, controller)

                resources = clean_numeric_section(room.get("resources"), RESOURCE_FIELDS)
                update_section(room_state.resources, resources)
                if isinstance(room.get("resources"), dict):
                    room_state.resource_event_seen = (
                        add_events(room_state.resource_events, room["resources"].get("events"), RESOURCE_EVENT_FIELDS)
                        or room_state.resource_event_seen
                    )

                combat = clean_numeric_section(room.get("combat"), COMBAT_FIELDS)
                update_section(room_state.combat, combat)
                if isinstance(room.get("combat"), dict):
                    room_state.combat_event_seen = (
                        add_events(room_state.combat_events, room["combat"].get("events"), COMBAT_EVENT_FIELDS)
                        or room_state.combat_event_seen
                    )

            if state.first_rooms is None:
                state.first_rooms = set(summary_rooms)
            state.latest_rooms = set(summary_rooms)

    return build_report(state)


def build_report(state: ReductionState) -> JsonObject:
    latest_rooms = set(state.latest_rooms or set())
    first_rooms = set(state.first_rooms or set())

    return {
        "type": REPORT_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "input": {
            "lineCount": state.line_count,
            "runtimeSummaryCount": state.runtime_summary_count,
            "ignoredLineCount": state.ignored_line_count,
            "malformedRuntimeSummaryCount": state.malformed_runtime_summary_count,
        },
        "window": {
            "firstTick": state.first_tick,
            "latestTick": state.latest_tick,
        },
        "territory": build_territory_report(state, first_rooms, latest_rooms),
        "resources": build_numeric_section_report(
            state.rooms,
            first_rooms,
            latest_rooms,
            RESOURCE_FIELDS,
            "resources",
            RESOURCE_EVENT_FIELDS,
            "resource_events",
            "resource_event_seen",
        ),
        "combat": build_numeric_section_report(
            state.rooms,
            first_rooms,
            latest_rooms,
            COMBAT_FIELDS,
            "combat",
            COMBAT_EVENT_FIELDS,
            "combat_events",
            "combat_event_seen",
        ),
        "roomMetrics": build_numeric_section_report(
            state.rooms,
            first_rooms,
            latest_rooms,
            ROOM_LEVEL_FIELDS,
            "room_metrics",
            (),
            "",
            "",
        ),
        "constructionActivity": build_construction_activity_report(state.rooms, latest_rooms),
    }


def build_territory_report(state: ReductionState, first_rooms: set[str], latest_rooms: set[str]) -> JsonObject:
    if not state.rooms_seen:
        owned_rooms: JsonObject = {
            "status": NOT_INSTRUMENTED,
            "message": NOT_INSTRUMENTED,
        }
    else:
        owned_rooms = {
            "status": OBSERVED,
            "latest": sorted(latest_rooms),
            "latestCount": len(latest_rooms),
            "deltaCount": len(latest_rooms) - len(first_rooms),
            "gained": sorted(latest_rooms - first_rooms),
            "lost": sorted(first_rooms - latest_rooms),
        }

    return {
        "status": OBSERVED if state.rooms_seen else NOT_INSTRUMENTED,
        "ownedRooms": owned_rooms,
        "controllers": build_numeric_section_report(
            state.rooms,
            first_rooms,
            latest_rooms,
            CONTROLLER_FIELDS,
            "controller",
            (),
            "",
            "",
        ),
    }


def build_numeric_section_report(
    rooms: dict[str, RoomState],
    first_rooms: set[str],
    latest_rooms: set[str],
    fields: tuple[str, ...],
    state_attr: str,
    event_fields: tuple[str, ...],
    event_attr: str,
    event_seen_attr: str,
) -> JsonObject:
    room_reports: dict[str, JsonObject] = {}
    missing_rooms: list[str] = []
    observed_room_count = 0

    for room_name in sorted(latest_rooms):
        room_state = rooms.get(room_name)
        section_state = getattr(room_state, state_attr) if room_state is not None else SectionState()
        if section_state.latest is None:
            room_reports[room_name] = {
                "status": NOT_INSTRUMENTED,
                "message": NOT_INSTRUMENTED,
            }
            missing_rooms.append(room_name)
            continue

        observed_room_count += 1
        report: JsonObject = {
            "status": OBSERVED,
            "latest": section_state.latest,
            "delta": numeric_delta(section_state.first, section_state.latest, fields),
        }

        if event_fields and room_state is not None:
            event_seen = bool(getattr(room_state, event_seen_attr))
            report["eventDeltas"] = {
                "status": OBSERVED if event_seen else NOT_OBSERVED,
                **getattr(room_state, event_attr),
            }

        room_reports[room_name] = report

    has_historical_values = has_section_values(rooms, set(rooms), state_attr)
    if observed_room_count == len(latest_rooms) and (observed_room_count > 0 or has_historical_values):
        status = OBSERVED
    elif has_historical_values:
        status = NOT_OBSERVED
    else:
        status = NOT_INSTRUMENTED
    report = {
        "status": status,
        "observedRoomCount": observed_room_count,
        "missingRooms": missing_rooms,
        "rooms": room_reports,
    }

    if status == NOT_INSTRUMENTED:
        report["message"] = NOT_INSTRUMENTED
        return report
    if status == NOT_OBSERVED:
        report["message"] = NOT_OBSERVED

    report["totals"] = {
        "latest": sum_latest_values(rooms, latest_rooms, fields, state_attr),
        "delta": sum_window_delta(rooms, first_rooms, latest_rooms, fields, state_attr),
    }

    if event_fields:
        events, event_seen = sum_events(rooms, set(rooms), event_fields, event_attr, event_seen_attr)
        report["eventDeltas"] = {
            "status": OBSERVED if event_seen else NOT_OBSERVED,
            **events,
        }

    return report


def build_construction_activity_report(rooms: dict[str, RoomState], latest_rooms: set[str]) -> JsonObject:
    room_reports: dict[str, JsonObject] = {}
    missing_rooms: list[str] = []
    state_counts: dict[str, int] = {}
    accepted_room_count = 0
    observed_room_count = 0

    for room_name in sorted(latest_rooms):
        room_state = rooms.get(room_name)
        activity = room_state.construction_activity_latest if room_state is not None else None
        if activity is None:
            room_reports[room_name] = {
                "status": NOT_INSTRUMENTED,
                "message": NOT_INSTRUMENTED,
            }
            missing_rooms.append(room_name)
            continue

        observed_room_count += 1
        state = text_value(activity.get("state")) or "unknown"
        state_counts[state] = state_counts.get(state, 0) + 1
        if activity.get("accepted") is True:
            accepted_room_count += 1
        room_reports[room_name] = {
            "status": OBSERVED,
            "latest": activity,
        }

    has_historical_values = any(room.construction_activity_first is not None for room in rooms.values())
    if observed_room_count == len(latest_rooms) and (observed_room_count > 0 or has_historical_values):
        status = OBSERVED
    elif has_historical_values:
        status = NOT_OBSERVED
    else:
        status = NOT_INSTRUMENTED

    report: JsonObject = {
        "status": status,
        "observedRoomCount": observed_room_count,
        "missingRooms": missing_rooms,
        "acceptedRoomCount": accepted_room_count,
        "stateCounts": dict(sorted(state_counts.items())),
        "rooms": room_reports,
    }
    if status == NOT_INSTRUMENTED:
        report["message"] = NOT_INSTRUMENTED
    elif status == NOT_OBSERVED:
        report["message"] = NOT_OBSERVED
    return report


def numeric_delta(
    first: dict[str, int | float | None] | None,
    latest: dict[str, int | float | None],
    fields: tuple[str, ...],
) -> dict[str, int | float | None]:
    deltas: dict[str, int | float | None] = {}
    for field_name in fields:
        first_value = first.get(field_name) if first is not None else None
        latest_value = latest.get(field_name)
        deltas[field_name] = latest_value - first_value if is_number(first_value) and is_number(latest_value) else None
    return deltas


def sum_latest_values(
    rooms: dict[str, RoomState],
    latest_rooms: set[str],
    fields: tuple[str, ...],
    state_attr: str,
) -> dict[str, int | float | None]:
    totals = zero_totals(fields)
    observed_fields = {field_name: False for field_name in fields}
    for room_name in latest_rooms:
        room_state = rooms.get(room_name)
        section_state = getattr(room_state, state_attr) if room_state is not None else None
        latest = section_state.latest if section_state is not None else None
        if latest is None:
            continue
        for field_name in fields:
            value = latest.get(field_name)
            if is_number(value):
                totals[field_name] += value
                observed_fields[field_name] = True
    return {field_name: totals[field_name] if observed_fields[field_name] else None for field_name in fields}


def has_section_values(rooms: dict[str, RoomState], room_names: set[str], state_attr: str) -> bool:
    for room_name in room_names:
        room_state = rooms.get(room_name)
        section_state = getattr(room_state, state_attr) if room_state is not None else None
        if section_state is not None and section_state.first is not None:
            return True
    return False


def sum_window_delta(
    rooms: dict[str, RoomState],
    first_rooms: set[str],
    latest_rooms: set[str],
    fields: tuple[str, ...],
    state_attr: str,
) -> dict[str, int | float | None]:
    totals = zero_totals(fields)
    observed_fields = {field_name: False for field_name in fields}
    for room_name in latest_rooms:
        room_state = rooms.get(room_name)
        section_state = getattr(room_state, state_attr) if room_state is not None else None
        latest = section_state.latest if section_state is not None else None
        if latest is None:
            continue
        for field_name in fields:
            value = latest.get(field_name)
            if is_number(value):
                totals[field_name] += value
                observed_fields[field_name] = True

    for room_name in first_rooms:
        room_state = rooms.get(room_name)
        section_state = getattr(room_state, state_attr) if room_state is not None else None
        first = section_state.first if section_state is not None else None
        if first is None:
            continue
        for field_name in fields:
            value = first.get(field_name)
            if is_number(value):
                totals[field_name] -= value
                observed_fields[field_name] = True
    return {field_name: totals[field_name] if observed_fields[field_name] else None for field_name in fields}


def sum_events(
    rooms: dict[str, RoomState],
    latest_rooms: set[str],
    fields: tuple[str, ...],
    event_attr: str,
    event_seen_attr: str,
) -> tuple[dict[str, int | float], bool]:
    totals = zero_totals(fields)
    seen = False
    for room_name in latest_rooms:
        room_state = rooms.get(room_name)
        if room_state is None:
            continue
        room_events = getattr(room_state, event_attr)
        seen = bool(getattr(room_state, event_seen_attr)) or seen
        for field_name in fields:
            value = room_events.get(field_name)
            if is_number(value):
                totals[field_name] += value
    return totals, seen


def iter_input_lines(paths: list[str], stdin: TextIO = sys.stdin) -> Iterable[str]:
    input_paths = paths or ["-"]
    for path_text in input_paths:
        if path_text == "-":
            yield from stdin
            continue

        with Path(path_text).open("r", encoding="utf-8") as input_file:
            yield from input_file


def render_json(report: JsonObject) -> str:
    return json.dumps(report, indent=2, sort_keys=True)


def render_human(report: JsonObject) -> str:
    lines = [
        f"runtime summaries: {report['input']['runtimeSummaryCount']} "
        f"(ignored {report['input']['ignoredLineCount']}, malformed {report['input']['malformedRuntimeSummaryCount']})",
        f"ticks: {format_value(report['window']['firstTick'])}..{format_value(report['window']['latestTick'])}",
    ]

    territory = report["territory"]
    owned_rooms = territory["ownedRooms"]
    if owned_rooms["status"] == OBSERVED:
        lines.append(
            f"territory: {owned_rooms['latestCount']} owned room(s): {', '.join(owned_rooms['latest']) or 'none'} "
            f"(delta {format_delta(owned_rooms['deltaCount'])})"
        )
    else:
        lines.append(f"territory: {NOT_INSTRUMENTED}")

    controller_lines = render_controller_human(territory["controllers"])
    if controller_lines:
        lines.extend(controller_lines)

    lines.append(render_section_human("resources", report["resources"], RESOURCE_FIELDS, RESOURCE_EVENT_FIELDS))
    lines.append(render_section_human("combat", report["combat"], COMBAT_FIELDS, COMBAT_EVENT_FIELDS))
    lines.append(render_section_human("roomMetrics", report["roomMetrics"], ROOM_LEVEL_FIELDS, ()))
    lines.append(render_construction_activity_human(report["constructionActivity"]))

    return "\n".join(lines)


def render_controller_human(controller_report: JsonObject) -> list[str]:
    if controller_report["status"] != OBSERVED:
        return [f"controllers: {controller_report['status']}"]

    lines: list[str] = []
    for room_name, room_report in controller_report["rooms"].items():
        if room_report["status"] != OBSERVED:
            lines.append(f"controller {room_name}: {NOT_INSTRUMENTED}")
            continue

        latest = room_report["latest"]
        delta = room_report["delta"]
        progress = format_progress(latest.get("progress"), latest.get("progressTotal"))
        lines.append(
            f"controller {room_name}: RCL {format_value(latest.get('level'))} "
            f"progress {progress} ({format_delta(delta.get('progress'))}) "
            f"downgrade {format_value(latest.get('ticksToDowngrade'))}"
        )

    return lines


def render_section_human(
    label: str,
    section_report: JsonObject,
    fields: tuple[str, ...],
    event_fields: tuple[str, ...],
) -> str:
    if section_report["status"] != OBSERVED:
        return f"{label}: {section_report['status']}"

    latest = section_report["totals"]["latest"]
    delta = section_report["totals"]["delta"]
    values = ", ".join(f"{field_name} {format_value(latest[field_name])} ({format_delta(delta[field_name])})" for field_name in fields)
    if not event_fields:
        return f"{label}: {values}"
    events = section_report.get("eventDeltas")
    if not isinstance(events, dict) or events["status"] != OBSERVED:
        return f"{label}: {values}; events {NOT_OBSERVED}"

    event_values = ", ".join(f"{field_name} {format_delta(events[field_name])}" for field_name in event_fields)
    return f"{label}: {values}; events {event_values}"


def render_construction_activity_human(section_report: JsonObject) -> str:
    if section_report["status"] != OBSERVED:
        return f"constructionActivity: {section_report['status']}"

    state_values = ", ".join(
        f"{state} {count}" for state, count in section_report.get("stateCounts", {}).items()
    )
    return (
        f"constructionActivity: accepted {section_report.get('acceptedRoomCount', 0)}/"
        f"{section_report.get('observedRoomCount', 0)} room(s); {state_values or 'no states'}"
    )


def format_progress(progress: Any, progress_total: Any) -> str:
    if progress is None and progress_total is None:
        return "unknown"
    return f"{format_value(progress)}/{format_value(progress_total)}"


def format_value(value: Any) -> str:
    return "unknown" if value is None else str(value)


def format_delta(value: Any) -> str:
    if not is_number(value):
        return "unknown"
    if value > 0:
        return f"+{value}"
    return str(value)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Reduce Screeps #runtime-summary JSON lines into compact Gameplay Evolution KPI evidence.",
    )
    parser.add_argument(
        "inputs",
        nargs="*",
        help="Input log files. Use '-' for stdin. Reads stdin when no inputs are provided.",
    )
    parser.add_argument(
        "--format",
        choices=("json", "human"),
        default="json",
        help="Output format. JSON is deterministic and is the default.",
    )
    return parser


def main(argv: list[str] | None = None, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> int:
    args = build_parser().parse_args(argv)
    report = reduce_runtime_kpis(iter_input_lines(args.inputs, stdin))
    output = render_human(report) if args.format == "human" else render_json(report)
    stdout.write(output)
    stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
