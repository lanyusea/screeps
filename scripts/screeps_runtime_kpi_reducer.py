#!/usr/bin/env python3
"""Reduce Screeps #runtime-summary lines into Gameplay Evolution KPIs."""

from __future__ import annotations

import argparse
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

CONTROLLER_FIELDS = ("level", "progress", "progressTotal", "ticksToDowngrade")
RESOURCE_FIELDS = ("storedEnergy", "workerCarriedEnergy", "droppedEnergy", "sourceCount")
RESOURCE_EVENT_FIELDS = ("harvestedEnergy", "transferredEnergy")
COMBAT_FIELDS = ("hostileCreepCount", "hostileStructureCount")
COMBAT_EVENT_FIELDS = ("attackCount", "attackDamage", "objectDestroyedCount", "creepDestroyedCount")


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
        payload, _ = json.JSONDecoder().raw_decode(payload_text)
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
            latest_rooms,
            RESOURCE_FIELDS,
            "resources",
            RESOURCE_EVENT_FIELDS,
            "resource_events",
            "resource_event_seen",
        ),
        "combat": build_numeric_section_report(
            state.rooms,
            latest_rooms,
            COMBAT_FIELDS,
            "combat",
            COMBAT_EVENT_FIELDS,
            "combat_events",
            "combat_event_seen",
        ),
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

    status = OBSERVED if observed_room_count > 0 else NOT_INSTRUMENTED
    report = {
        "status": status,
        "observedRoomCount": observed_room_count,
        "missingRooms": missing_rooms,
        "rooms": room_reports,
    }

    if status == NOT_INSTRUMENTED:
        report["message"] = NOT_INSTRUMENTED
        return report

    report["totals"] = {
        "latest": sum_latest_values(rooms, latest_rooms, fields, state_attr),
        "delta": sum_latest_delta(rooms, latest_rooms, fields, state_attr),
    }

    if event_fields:
        events, event_seen = sum_events(rooms, set(rooms), event_fields, event_attr, event_seen_attr)
        report["eventDeltas"] = {
            "status": OBSERVED if event_seen else NOT_OBSERVED,
            **events,
        }

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
) -> dict[str, int | float]:
    totals = zero_totals(fields)
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
    return totals


def sum_latest_delta(
    rooms: dict[str, RoomState],
    latest_rooms: set[str],
    fields: tuple[str, ...],
    state_attr: str,
) -> dict[str, int | float]:
    totals = zero_totals(fields)
    for room_name in latest_rooms:
        room_state = rooms.get(room_name)
        section_state = getattr(room_state, state_attr) if room_state is not None else None
        if section_state is None or section_state.latest is None:
            continue
        delta = numeric_delta(section_state.first, section_state.latest, fields)
        for field_name, value in delta.items():
            if is_number(value):
                totals[field_name] += value
    return totals


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

    return "\n".join(lines)


def render_controller_human(controller_report: JsonObject) -> list[str]:
    if controller_report["status"] != OBSERVED:
        return [f"controllers: {NOT_INSTRUMENTED}"]

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
        return f"{label}: {NOT_INSTRUMENTED}"

    latest = section_report["totals"]["latest"]
    delta = section_report["totals"]["delta"]
    values = ", ".join(f"{field_name} {format_value(latest[field_name])} ({format_delta(delta[field_name])})" for field_name in fields)
    events = section_report.get("eventDeltas")
    if not isinstance(events, dict) or events["status"] != OBSERVED:
        return f"{label}: {values}; events {NOT_OBSERVED}"

    event_values = ", ".join(f"{field_name} {format_delta(events[field_name])}" for field_name in event_fields)
    return f"{label}: {values}; events {event_values}"


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
