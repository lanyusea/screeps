#!/usr/bin/env python3
"""Extract offline high-level strategy recommendation windows from Screeps artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence, TextIO

import screeps_rl_dataset_export as dataset_export
import screeps_runtime_kpi_reducer as kpi_reducer


SCHEMA_VERSION = 1
DATASET_TYPE = "screeps-strategy-recommendation-window"
DEFAULT_OUT_PATH = Path("runtime-artifacts/strategy-datasets/strategy_windows.jsonl")
DEFAULT_REGISTRY_PATH = Path("prod/src/strategy/strategyRegistry.ts")
DEFAULT_WINDOW_SIZE = 3
DEFAULT_SAMPLE_LIMIT = 500
DEFAULT_EVAL_RATIO = 0.2
DEFAULT_SPLIT_SEED = "screeps-strategy-recommendation-v1"
ENTRY_RE = re.compile(
    r"id:\s*'(?P<id>[^']+)'.*?"
    r"version:\s*'(?P<version>[^']+)'.*?"
    r"family:\s*'(?P<family>[^']+)'.*?"
    r"rolloutStatus:\s*'(?P<rollout_status>[^']+)'",
    re.DOTALL,
)

JsonObject = dict[str, Any]


@dataclass(frozen=True)
class StrategyRegistryEntry:
    strategy_id: str
    version: str
    family: str
    rollout_status: str


@dataclass(frozen=True)
class RoomFrame:
    record: dataset_export.ArtifactRecord
    record_index: int
    room: JsonObject
    tick: int | float | None


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def eval_ratio(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a number") from error
    if parsed < 0 or parsed >= 1:
        raise argparse.ArgumentTypeError("must be at least 0 and less than 1")
    return parsed


def extract_strategy_dataset(
    paths: Sequence[str],
    out_path: Path = DEFAULT_OUT_PATH,
    *,
    registry_path: Path = DEFAULT_REGISTRY_PATH,
    window_size: int = DEFAULT_WINDOW_SIZE,
    sample_limit: int = DEFAULT_SAMPLE_LIMIT,
    eval_ratio_value: float = DEFAULT_EVAL_RATIO,
    split_seed: str = DEFAULT_SPLIT_SEED,
    max_file_bytes: int = dataset_export.DEFAULT_MAX_FILE_BYTES,
    bot_commit: str | None = None,
    repo_root: Path | None = None,
) -> JsonObject:
    repo = (repo_root or Path.cwd()).resolve()
    resolved_out_path = resolve_path_against_repo(out_path, repo)
    resolved_registry_path = resolve_path_against_repo(registry_path, repo)
    registry = read_strategy_registry(resolved_registry_path)
    bot_commit = bot_commit or dataset_export.git_commit(repo)
    scan = dataset_export.collect_artifact_records(
        paths,
        max_file_bytes=max_file_bytes,
        excluded_roots=[resolved_out_path.parent],
    )
    rows = build_labeled_windows(
        scan.records,
        registry,
        bot_commit=bot_commit,
        window_size=window_size,
        sample_limit=sample_limit,
        eval_ratio_value=eval_ratio_value,
        split_seed=split_seed,
    )
    runtime_lines = [
        kpi_reducer.RUNTIME_SUMMARY_PREFIX
        + json.dumps(record.payload, sort_keys=True, separators=(",", ":"))
        + "\n"
        for record in scan.records
    ]
    kpi_history = kpi_reducer.reduce_runtime_kpis(runtime_lines)

    write_jsonl_atomic(resolved_out_path, rows)
    manifest_path = resolved_out_path.with_suffix(".manifest.json")
    manifest = {
        "ok": True,
        "type": "screeps-strategy-recommendation-dataset-manifest",
        "schemaVersion": SCHEMA_VERSION,
        "datasetPath": dataset_export.display_path(resolved_out_path),
        "manifestPath": dataset_export.display_path(manifest_path),
        "rowCount": len(rows),
        "sourceArtifactCount": len(scan.source_files),
        "runtimeSummaryArtifactCount": len(scan.records),
        "skippedFileCount": len(scan.skipped_files),
        "registryPath": dataset_export.display_path(resolved_registry_path),
        "strategyVersions": [strategy_entry_to_json(entry) for entry in registry],
        "windowSize": window_size,
        "split": {
            "method": "sha256-threshold",
            "seed": split_seed,
            "evalRatio": eval_ratio_value,
            "counts": count_splits(rows),
        },
        "kpiHistory": kpi_history,
        "safety": safety_notes(),
    }
    write_json_atomic(manifest_path, manifest)
    return manifest


def build_labeled_windows(
    records: Sequence[dataset_export.ArtifactRecord],
    registry: Sequence[StrategyRegistryEntry],
    *,
    bot_commit: str,
    window_size: int,
    sample_limit: int,
    eval_ratio_value: float,
    split_seed: str,
) -> list[JsonObject]:
    frames_by_room = collect_room_frames(records)
    rows: list[JsonObject] = []
    for room_name in sorted(frames_by_room):
        frames = frames_by_room[room_name]
        for window in iter_room_windows(frames, window_size):
            latest_frame = window[-1]
            labels = build_labels(latest_frame.room, registry)
            reward = build_window_reward(window, labels)
            if not reward["successful"]:
                continue
            sample_id = build_sample_id(window)
            rows.append(
                {
                    "type": DATASET_TYPE,
                    "schemaVersion": SCHEMA_VERSION,
                    "sampleId": sample_id,
                    "botCommit": bot_commit,
                    "sourceWindow": [build_source_window_entry(frame) for frame in window],
                    "features": build_features(latest_frame.record.payload, latest_frame.room),
                    "labels": labels,
                    "reward": reward,
                    "strategyVersions": [strategy_entry_to_json(entry) for entry in registry],
                    "split": assign_split(sample_id, split_seed, eval_ratio_value),
                    "safety": safety_notes(),
                }
            )
            if len(rows) >= sample_limit:
                return rows
    return rows


def collect_room_frames(records: Sequence[dataset_export.ArtifactRecord]) -> dict[str, list[RoomFrame]]:
    frames_by_room: dict[str, list[RoomFrame]] = {}
    for record_index, record in enumerate(records):
        rooms = record.payload.get("rooms")
        if not isinstance(rooms, list):
            continue
        for room in rooms:
            if not isinstance(room, dict):
                continue
            room_name = room.get("roomName")
            if not isinstance(room_name, str) or not room_name:
                continue
            frame = RoomFrame(
                record=record,
                record_index=record_index,
                room=room,
                tick=number_or_none(record.payload.get("tick")),
            )
            frames_by_room.setdefault(room_name, []).append(frame)

    for frames in frames_by_room.values():
        frames.sort(key=lambda frame: (frame.tick is None, frame.tick or 0, frame.record.source.display_path, frame.record_index))
    return frames_by_room


def iter_room_windows(frames: Sequence[RoomFrame], window_size: int) -> list[list[RoomFrame]]:
    if not frames:
        return []
    if len(frames) <= window_size:
        return [list(frames)]
    return [list(frames[index : index + window_size]) for index in range(0, len(frames) - window_size + 1)]


def build_features(payload: JsonObject, room: JsonObject) -> JsonObject:
    territory = room.get("territoryRecommendation") if isinstance(room.get("territoryRecommendation"), dict) else {}
    candidates = territory.get("candidates") if isinstance(territory.get("candidates"), list) else []
    expansion_candidates = [
        candidate
        for candidate in candidates
        if isinstance(candidate, dict) and candidate.get("action") in {"claim", "occupy"}
    ]
    remote_candidates = [
        candidate
        for candidate in candidates
        if isinstance(candidate, dict) and candidate.get("action") in {"reserve", "scout"}
    ]
    resources = room.get("resources") if isinstance(room.get("resources"), dict) else {}
    combat = room.get("combat") if isinstance(room.get("combat"), dict) else {}
    controller = room.get("controller") if isinstance(room.get("controller"), dict) else {}

    return {
        "tick": number_or_none(payload.get("tick")),
        "roomName": redact_string(room.get("roomName")),
        "rcl": number_or_none(controller.get("level")),
        "creeps": {
            "total": number_or_none(room.get("creepCount")),
            "workers": number_or_none(room.get("workerCount")),
            "taskCounts": select_number_map(room.get("taskCounts")),
        },
        "energy": {
            "available": number_or_none(room.get("energyAvailable")),
            "capacity": number_or_none(room.get("energyCapacity")),
            "stored": number_or_none(resources.get("storedEnergy")),
            "workerCarried": number_or_none(resources.get("workerCarriedEnergy")),
            "dropped": number_or_none(resources.get("droppedEnergy")),
        },
        "hostiles": {
            "creeps": number_or_zero(combat.get("hostileCreepCount")),
            "structures": number_or_zero(combat.get("hostileStructureCount")),
        },
        "territory": {
            "ownedRoomCountObserved": count_owned_rooms(payload),
            "sourceCount": number_or_none(resources.get("sourceCount")),
            "remoteCandidateCount": len(remote_candidates),
            "expansionCandidateCount": len(expansion_candidates),
            "nextTarget": summarize_territory_candidate(territory.get("next")),
        },
    }


def build_labels(room: JsonObject, registry: Sequence[StrategyRegistryEntry]) -> JsonObject:
    construction_priority = None
    construction = room.get("constructionPriority")
    if isinstance(construction, dict) and isinstance(construction.get("nextPrimary"), dict):
        construction_priority = redact_string(construction["nextPrimary"].get("buildItem"))

    territory_next = None
    territory = room.get("territoryRecommendation")
    if isinstance(territory, dict):
        territory_next = territory.get("next")

    expansion_target = None
    remote_target = None
    if isinstance(territory_next, dict):
        action = territory_next.get("action")
        room_name = redact_string(territory_next.get("roomName"))
        if action in {"claim", "occupy"}:
            expansion_target = room_name
        elif action in {"reserve", "scout"}:
            remote_target = room_name

    defense_posture = infer_defense_posture(room)
    strategy_ids = select_strategy_ids(registry, construction_priority, expansion_target, remote_target, defense_posture)
    return {
        "strategyPreset": "+".join(strategy_ids) if strategy_ids else "incumbent-baseline",
        "strategyIds": strategy_ids,
        "expansionTarget": expansion_target,
        "remoteTarget": remote_target,
        "constructionPriority": construction_priority,
        "defensePosture": defense_posture,
        "liveEffect": False,
    }


def build_window_reward(window: Sequence[RoomFrame], labels: JsonObject) -> JsonObject:
    first_features = build_features(window[0].record.payload, window[0].room)
    latest_features = build_features(window[-1].record.payload, window[-1].room)
    first_rcl = nested_number(first_features, ("rcl",))
    latest_rcl = nested_number(latest_features, ("rcl",))
    first_energy = nested_number(first_features, ("energy", "stored"))
    latest_energy = nested_number(latest_features, ("energy", "stored"))
    latest_hostiles = number_or_zero(nested_get(latest_features, ("hostiles", "creeps"))) + number_or_zero(
        nested_get(latest_features, ("hostiles", "structures"))
    )
    latest_workers = number_or_zero(nested_get(latest_features, ("creeps", "workers")))
    latest_controller = window[-1].room.get("controller") if isinstance(window[-1].room.get("controller"), dict) else {}
    ticks_to_downgrade = number_or_none(latest_controller.get("ticksToDowngrade"))

    has_action_label = any(
        labels.get(field_name) is not None
        for field_name in ("expansionTarget", "remoteTarget", "constructionPriority", "defensePosture")
    )
    controller_non_degraded = first_rcl is None or latest_rcl is None or latest_rcl >= first_rcl
    no_critical_downgrade = ticks_to_downgrade is None or ticks_to_downgrade >= 1000
    hostile_response_valid = latest_hostiles == 0 or labels.get("defensePosture") == "active"
    worker_survival = latest_workers > 0 or labels.get("constructionPriority") == "build initial spawn"
    successful = bool(has_action_label and controller_non_degraded and no_critical_downgrade and hostile_response_valid and worker_survival)

    return {
        "successful": successful,
        "status": "heuristic-success-label" if successful else "filtered",
        "scalarReward": None,
        "lexicographicOrder": ["territory", "resources", "kills"],
        "components": {
            "territory": {
                "rclDelta": numeric_delta(first_rcl, latest_rcl),
                "ownedRoomCountObserved": nested_get(latest_features, ("territory", "ownedRoomCountObserved")),
                "controllerNonDegraded": controller_non_degraded,
                "ticksToDowngrade": ticks_to_downgrade,
            },
            "resources": {
                "storedEnergyDelta": numeric_delta(first_energy, latest_energy),
                "energyCapacity": nested_get(latest_features, ("energy", "capacity")),
            },
            "kills": {
                "hostilePressure": latest_hostiles,
                "defensePosture": labels.get("defensePosture"),
            },
        },
        "notes": "Success is a conservative offline label from retained room/control state, worker survival, and hostile response posture.",
    }


def select_strategy_ids(
    registry: Sequence[StrategyRegistryEntry],
    construction_priority: str | None,
    expansion_target: str | None,
    remote_target: str | None,
    defense_posture: str,
) -> list[str]:
    families: list[str] = []
    if construction_priority:
        families.append("construction-priority")
    if expansion_target or remote_target:
        families.append("expansion-remote-candidate")
    if defense_posture in {"alert", "active"}:
        families.append("defense-posture-repair-threshold")
    if not families:
        families.append("construction-priority")

    selected: list[str] = []
    for family in families:
        incumbent = next(
            (
                entry
                for entry in registry
                if entry.family == family and entry.rollout_status == "incumbent"
            ),
            None,
        )
        selected.append(incumbent.strategy_id if incumbent else f"{family}.incumbent")
    return selected


def infer_defense_posture(room: JsonObject) -> str:
    combat = room.get("combat") if isinstance(room.get("combat"), dict) else {}
    hostile_creeps = number_or_zero(combat.get("hostileCreepCount"))
    hostile_structures = number_or_zero(combat.get("hostileStructureCount"))
    if hostile_creeps > 0:
        return "active"
    if hostile_structures > 0:
        return "alert"
    return "passive"


def build_sample_id(window: Sequence[RoomFrame]) -> str:
    seed = [
        {
            "sourceId": frame.record.source.source_id,
            "lineNumber": frame.record.line_number,
            "recordIndex": frame.record_index,
            "roomName": frame.room.get("roomName"),
            "tick": frame.tick,
        }
        for frame in window
    ]
    digest = hashlib.sha256(json.dumps(seed, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return f"strategy-window-{digest[:16]}"


def build_source_window_entry(frame: RoomFrame) -> JsonObject:
    return {
        "sourceId": frame.record.source.source_id,
        "artifactKind": frame.record.artifact_kind,
        "path": frame.record.source.display_path,
        "lineNumber": frame.record.line_number,
        "tick": frame.tick,
        "roomName": redact_string(frame.room.get("roomName")),
        "sha256": frame.record.source.sha256,
    }


def read_strategy_registry(path: Path) -> list[StrategyRegistryEntry]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise FileNotFoundError(f"strategy registry not readable: {dataset_export.display_path(path)}") from error

    entries = [
        StrategyRegistryEntry(
            strategy_id=match.group("id"),
            version=match.group("version"),
            family=match.group("family"),
            rollout_status=match.group("rollout_status"),
        )
        for match in ENTRY_RE.finditer(text)
    ]
    if not entries:
        raise ValueError(f"no strategy registry entries found in {dataset_export.display_path(path)}")
    return entries


def summarize_territory_candidate(candidate: Any) -> JsonObject | None:
    if not isinstance(candidate, dict) or not isinstance(candidate.get("roomName"), str):
        return None
    return {
        "roomName": redact_string(candidate.get("roomName")),
        "action": redact_string(candidate.get("action")),
        "score": number_or_none(candidate.get("score")),
        "routeDistance": number_or_none(candidate.get("routeDistance")),
        "sourceCount": number_or_none(candidate.get("sourceCount")),
        "evidenceStatus": redact_string(candidate.get("evidenceStatus")),
    }


def count_owned_rooms(payload: JsonObject) -> int:
    rooms = payload.get("rooms")
    if not isinstance(rooms, list):
        return 0
    return len([room for room in rooms if isinstance(room, dict) and isinstance(room.get("roomName"), str)])


def assign_split(sample_id: str, split_seed: str, eval_ratio_value: float) -> JsonObject:
    digest = hashlib.sha256(f"{split_seed}:{sample_id}".encode("utf-8")).hexdigest()
    bucket = int(digest[:12], 16) / float(0xFFFFFFFFFFFF)
    split = "eval" if bucket < eval_ratio_value else "train"
    return {
        "name": split,
        "method": "sha256-threshold",
        "seed": split_seed,
        "evalRatio": eval_ratio_value,
        "bucket": round(bucket, 8),
    }


def count_splits(rows: Sequence[JsonObject]) -> JsonObject:
    counts: dict[str, int] = {}
    for row in rows:
        split = row.get("split")
        name = split.get("name") if isinstance(split, dict) else None
        counts[str(name or "unknown")] = counts.get(str(name or "unknown"), 0) + 1
    return dict(sorted(counts.items()))


def safety_notes() -> JsonObject:
    return {
        "liveEffect": False,
        "mode": "offline extraction and shadow recommendation only",
        "officialMmoControl": "forbidden until simulator evidence, historical validation, rollout gates, and rollback gates pass",
        "rawCreepIntentControl": False,
    }


def resolve_path_against_repo(path: Path, repo_root: Path) -> Path:
    expanded = path.expanduser()
    return (expanded if expanded.is_absolute() else repo_root / expanded).resolve()


def write_jsonl_atomic(path: Path, rows: Sequence[JsonObject]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=True))
                handle.write("\n")
        os.replace(temp_name, path)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def write_json_atomic(path: Path, payload: JsonObject) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, sort_keys=True, indent=2)
            handle.write("\n")
        os.replace(temp_name, path)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def strategy_entry_to_json(entry: StrategyRegistryEntry) -> JsonObject:
    return {
        "id": entry.strategy_id,
        "version": entry.version,
        "family": entry.family,
        "rolloutStatus": entry.rollout_status,
    }


def select_number_map(value: Any) -> JsonObject:
    if not isinstance(value, dict):
        return {}
    return {str(key): item for key, item in value.items() if is_number(item)}


def nested_get(value: Any, keys: tuple[str, ...]) -> Any:
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def nested_number(value: Any, keys: tuple[str, ...]) -> int | float | None:
    return number_or_none(nested_get(value, keys))


def numeric_delta(first: int | float | None, latest: int | float | None) -> int | float | None:
    if first is None or latest is None:
        return None
    return latest - first


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def number_or_none(value: Any) -> int | float | None:
    return value if is_number(value) else None


def number_or_zero(value: Any) -> int | float:
    return value if is_number(value) else 0


def redact_string(value: Any) -> str | None:
    return dataset_export.redact_text(value) if isinstance(value, str) else None


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", help="Runtime artifact files or directories to scan.")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_PATH, help="JSONL dataset output path.")
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY_PATH, help="Strategy registry path.")
    parser.add_argument("--window-size", type=positive_int, default=DEFAULT_WINDOW_SIZE)
    parser.add_argument("--sample-limit", type=positive_int, default=DEFAULT_SAMPLE_LIMIT)
    parser.add_argument("--eval-ratio", type=eval_ratio, default=DEFAULT_EVAL_RATIO)
    parser.add_argument("--split-seed", default=DEFAULT_SPLIT_SEED)
    parser.add_argument("--max-file-bytes", type=positive_int, default=dataset_export.DEFAULT_MAX_FILE_BYTES)
    parser.add_argument("--bot-commit", default=None)
    return parser


def main(argv: Sequence[str] | None = None, stdout: TextIO = sys.stdout) -> int:
    args = build_arg_parser().parse_args(argv)
    manifest = extract_strategy_dataset(
        args.paths,
        args.out,
        registry_path=args.registry,
        window_size=args.window_size,
        sample_limit=args.sample_limit,
        eval_ratio_value=args.eval_ratio,
        split_seed=args.split_seed,
        max_file_bytes=args.max_file_bytes,
        bot_commit=args.bot_commit,
    )
    stdout.write(json.dumps(manifest, sort_keys=True))
    stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
