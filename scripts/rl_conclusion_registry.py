#!/usr/bin/env python3
"""Read-modify-write helpers for the RL conclusion registry."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Sequence


SCHEMA_VERSION = 1
REGISTRY_TYPE = "rl-conclusion-registry"
CONCLUSION_STATUSES = ("OPEN", "STALE", "ACTIONED", "VALIDATING", "CLOSED", "ESCALATED")

JsonObject = dict[str, Any]


class ConclusionRegistryError(ValueError):
    """Raised when a conclusion registry update would lose or corrupt records."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


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

    merged = dict(existing_records)
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
        if previous is not None and previous_owner != owner_cron:
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
    for record in records.values():
        status = str(record.get("status", "UNKNOWN")).upper()
        if status in status_counts:
            status_counts[status] += 1

    return {
        "total": len(records),
        "new": new_count,
        "open": status_counts["OPEN"],
        "actioned": status_counts["ACTIONED"],
        "validating": status_counts["VALIDATING"],
        "closedThisWindow": closed_this_window,
        "staleOrEscalated": status_counts["STALE"] + status_counts["ESCALATED"],
    }


def merge_registry_file(
    path: Path,
    producer_conclusions: Sequence[JsonObject] | JsonObject,
    *,
    owner_cron: str,
    updated_at: str,
    updated_by: str | None = None,
) -> JsonObject:
    merged = merge_registry_payload(
        load_registry(path),
        producer_conclusions,
        owner_cron=owner_cron,
        updated_at=updated_at,
        updated_by=updated_by,
    )
    write_json_atomic(path, merged)
    return merged
