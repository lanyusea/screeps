#!/usr/bin/env python3
"""Export a small offline RL dataset sample from local Screeps artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence, TextIO

import screeps_runtime_kpi_reducer as reducer


SCHEMA_VERSION = 1
DATASET_TYPE = "screeps-rl-offline-dataset"
RUN_MANIFEST_TYPE = "screeps-rl-dataset-run"
SCENARIO_MANIFEST_TYPE = "screeps-rl-historical-artifact-replay"
DEFAULT_INPUT_PATHS = (
    "/root/screeps/runtime-artifacts",
    "/root/.hermes/cron/output",
    "runtime-artifacts",
)
DEFAULT_OUT_DIR = Path("runtime-artifacts/rl-datasets")
DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024
DEFAULT_SAMPLE_LIMIT = 200
DEFAULT_EVAL_RATIO = 0.2
RUN_ID_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
ROOM_RE = re.compile(r"^(?:(?P<shard>[^/]+)/)?(?P<room>[WE]\d+[NS]\d+)$")
SECRET_TEXT_RE = re.compile(
    r"(?i)(x-token|authorization|token|password|secret|steam[_-]?key)\s*[:=]\s*(?:bearer\s+)?[^,\s}\"']+"
)
SECRET_ENV_NAMES = (
    "SCREEPS_AUTH_TOKEN",
    "STEAM_KEY",
    "SCREEPS_PRIVATE_SMOKE_PASSWORD",
    "SCREEPS_PRIVATE_SERVER_PASSWORD",
)

JsonObject = dict[str, Any]


@dataclass(frozen=True)
class SourceFile:
    source_id: str
    path: str
    display_path: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True)
class ArtifactRecord:
    source: SourceFile
    artifact_kind: str
    payload: JsonObject
    line_number: int | None = None


@dataclass
class ScanResult:
    input_paths: list[str]
    source_files: dict[str, SourceFile] = field(default_factory=dict)
    records: list[ArtifactRecord] = field(default_factory=list)
    strategy_shadow_reports: list[JsonObject] = field(default_factory=list)
    skipped_files: list[JsonObject] = field(default_factory=list)
    scanned_files: int = 0

    def skip(self, path: Path | str, reason: str, **details: Any) -> None:
        entry: JsonObject = {"path": display_path(path), "reason": reason}
        entry.update(details)
        self.skipped_files.append(entry)


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


def display_path(path: Path | str) -> str:
    text = str(path)
    try:
        path_obj = Path(text)
        if path_obj.is_absolute():
            try:
                return str(path_obj.resolve().relative_to(Path.cwd().resolve()))
            except ValueError:
                return redact_text(str(path_obj))
    except OSError:
        return redact_text(text)
    return redact_text(text)


def redacted_input_paths(paths: Sequence[str]) -> list[str]:
    return [display_path(Path(path).expanduser()) for path in paths]


def redact_text(text: str) -> str:
    redacted = text
    for secret in configured_secret_values():
        if secret and len(secret) >= 6:
            redacted = redacted.replace(secret, "[REDACTED]")
    redacted = SECRET_TEXT_RE.sub(lambda match: f"{match.group(1)}=[REDACTED]", redacted)
    redacted = re.sub(r"/root/\.secret/[^,\s\"']+", "[REDACTED_SECRET_PATH]", redacted)
    return redacted


def configured_secret_values() -> list[str]:
    return [os.environ.get(name, "") for name in SECRET_ENV_NAMES]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def git_commit(repo_root: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except (OSError, subprocess.CalledProcessError):
        return "unknown"
    return result.stdout.strip() or "unknown"


def collect_artifact_records(paths: Sequence[str], max_file_bytes: int = DEFAULT_MAX_FILE_BYTES) -> ScanResult:
    input_paths = list(paths) if paths else list(DEFAULT_INPUT_PATHS)
    result = ScanResult(input_paths=input_paths)

    for path_text in input_paths:
        path = Path(path_text).expanduser()
        if not path.exists():
            result.skip(path, "missing")
            continue
        if path.is_file():
            scan_file(path, result, max_file_bytes)
            continue
        if path.is_dir():
            for file_path in iter_directory_files(path, result):
                scan_file(file_path, result, max_file_bytes)
            continue
        result.skip(path, "not_file_or_directory")

    result.records.sort(key=record_sort_key)
    return result


def iter_directory_files(root: Path, result: ScanResult) -> list[Path]:
    files: list[Path] = []

    def record_error(error: OSError) -> None:
        result.skip(error.filename or root, "read_error")

    for dirpath, dirnames, filenames in os.walk(root, topdown=True, onerror=record_error, followlinks=False):
        dirnames[:] = sorted(dirnames)
        directory = Path(dirpath)
        for filename in sorted(filenames):
            files.append(directory / filename)

    return sorted(files, key=lambda path: str(path))


def scan_file(path: Path, result: ScanResult, max_file_bytes: int) -> None:
    if path.is_symlink():
        result.skip(path, "symlink")
        return

    try:
        stat_result = path.stat()
    except OSError:
        result.skip(path, "read_error")
        return

    if not path.is_file():
        result.skip(path, "not_regular_file")
        return

    result.scanned_files += 1
    if stat_result.st_size > max_file_bytes:
        result.skip(path, "oversized", sizeBytes=stat_result.st_size, maxFileBytes=max_file_bytes)
        return

    try:
        data = path.read_bytes()
    except OSError:
        result.skip(path, "read_error")
        return

    if b"\0" in data:
        result.skip(path, "binary")
        return

    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        result.skip(path, "binary")
        return

    source = SourceFile(
        source_id=f"src-{sha256_bytes((str(path.resolve()) + sha256_bytes(data)).encode('utf-8'))[:12]}",
        path=str(path),
        display_path=display_path(path),
        size_bytes=stat_result.st_size,
        sha256=sha256_bytes(data),
    )
    result.source_files[source.source_id] = source

    for record in parse_text_records(text, source):
        result.records.append(record)
    result.strategy_shadow_reports.extend(parse_strategy_shadow_reports(text, source))


def parse_text_records(text: str, source: SourceFile) -> list[ArtifactRecord]:
    records: list[ArtifactRecord] = []
    prefixed_lines: set[int] = set()

    for line_number, line in enumerate(text.splitlines(), start=1):
        if not line.startswith(reducer.RUNTIME_SUMMARY_PREFIX):
            continue
        prefixed_lines.add(line_number)
        payload = parse_runtime_summary_line(line)
        if payload is not None:
            records.append(
                ArtifactRecord(
                    source=source,
                    artifact_kind="runtime-summary-line",
                    payload=payload,
                    line_number=line_number,
                )
            )

    for line_number, document in iter_json_documents(text):
        if line_number in prefixed_lines:
            continue
        records.extend(records_from_json_document(document, source, line_number))

    return records


def parse_runtime_summary_line(line: str) -> JsonObject | None:
    payload, malformed = reducer.parse_runtime_summary_line(line)
    if malformed or payload is None:
        return None
    return payload


def iter_json_documents(text: str) -> Iterable[tuple[int | None, Any]]:
    stripped = text.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        whole = parse_json(stripped)
        if whole is not None:
            yield None, whole
            return

    for line_number, line in enumerate(text.splitlines(), start=1):
        stripped_line = line.strip()
        if not stripped_line or not (stripped_line.startswith("{") or stripped_line.startswith("[")):
            continue
        parsed = parse_json(stripped_line)
        if parsed is not None:
            yield line_number, parsed


def parse_json(text: str) -> Any | None:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def records_from_json_document(document: Any, source: SourceFile, line_number: int | None) -> list[ArtifactRecord]:
    records: list[ArtifactRecord] = []
    for item in flatten_json_documents(document):
        if not isinstance(item, dict):
            continue
        runtime_payload = normalize_runtime_summary_payload(item)
        if runtime_payload is not None:
            records.append(
                ArtifactRecord(
                    source=source,
                    artifact_kind="runtime-summary-json",
                    payload=runtime_payload,
                    line_number=line_number,
                )
            )
            continue

        monitor_payload = runtime_summary_from_monitor_json(item)
        if monitor_payload is not None:
            records.append(
                ArtifactRecord(
                    source=source,
                    artifact_kind="monitor-summary-json",
                    payload=monitor_payload,
                    line_number=line_number,
                )
            )
    return records


def parse_strategy_shadow_reports(text: str, source: SourceFile) -> list[JsonObject]:
    reports: list[JsonObject] = []
    for line_number, document in iter_json_documents(text):
        for item in flatten_json_documents(document):
            if not isinstance(item, dict):
                continue
            metadata = strategy_shadow_report_metadata(item, source, line_number)
            if metadata is not None:
                reports.append(metadata)
    return reports


def strategy_shadow_report_metadata(raw: JsonObject, source: SourceFile, line_number: int | None) -> JsonObject | None:
    model_reports = raw.get("modelReports")
    if not isinstance(model_reports, list):
        return None

    families: set[str] = set()
    candidate_ids: set[str] = set()
    incumbent_ids: set[str] = set()
    ranking_diff_count = 0
    for report in model_reports:
        if not isinstance(report, dict):
            continue
        if isinstance(report.get("family"), str):
            families.add(report["family"])
        if isinstance(report.get("candidateStrategyId"), str):
            candidate_ids.add(report["candidateStrategyId"])
        if isinstance(report.get("incumbentStrategyId"), str):
            incumbent_ids.add(report["incumbentStrategyId"])
        if isinstance(report.get("rankingDiffs"), list):
            ranking_diff_count += len(report["rankingDiffs"])

    return {
        "sourceId": source.source_id,
        "path": source.display_path,
        "lineNumber": line_number,
        "enabled": raw.get("enabled") if isinstance(raw.get("enabled"), bool) else None,
        "artifactCount": number_or_none(raw.get("artifactCount")),
        "modelReportCount": len(model_reports),
        "rankingDiffCount": ranking_diff_count,
        "families": sorted(families),
        "candidateStrategyIds": sorted(candidate_ids),
        "incumbentStrategyIds": sorted(incumbent_ids),
    }


def flatten_json_documents(document: Any) -> Iterable[Any]:
    if isinstance(document, list):
        for item in document:
            yield from flatten_json_documents(item)
        return
    yield document


def normalize_runtime_summary_payload(raw: JsonObject) -> JsonObject | None:
    if raw.get("type") == "runtime-summary" or raw.get("artifactType") == "runtime-summary":
        rooms = raw.get("rooms")
        if isinstance(rooms, list):
            return dict(raw, type="runtime-summary")
    return None


def runtime_summary_from_monitor_json(raw: JsonObject) -> JsonObject | None:
    if raw.get("mode") != "summary" or not isinstance(raw.get("room_summaries"), list):
        return None

    rooms: list[JsonObject] = []
    ticks: list[int] = []
    for room_summary in raw["room_summaries"]:
        if not isinstance(room_summary, dict):
            continue
        room_name, shard = parse_monitor_room_name(room_summary)
        if not room_name:
            continue
        tick = room_summary.get("tick")
        if is_number(tick):
            ticks.append(int(tick))
        rooms.append(
            {
                "roomName": room_name,
                **({"shard": shard} if shard else {}),
                **({"workerCount": room_summary["owned_creeps"]} if is_number(room_summary.get("owned_creeps")) else {}),
                "resources": {},
                "combat": {
                    "hostileCreepCount": number_or_zero(room_summary.get("hostiles")),
                    "hostileStructureCount": 0,
                },
                "monitor": {
                    "objectCount": number_or_none(room_summary.get("objects")),
                    "structureCount": number_or_none(room_summary.get("structures")),
                    "ownedSpawnCount": number_or_none(room_summary.get("owned_spawns")),
                },
            }
        )

    if not rooms:
        return None

    return {
        "type": "runtime-summary",
        "source": "screeps-runtime-monitor-json",
        "tick": max(ticks) if ticks else None,
        "rooms": rooms,
    }


def parse_monitor_room_name(room_summary: JsonObject) -> tuple[str | None, str | None]:
    name = room_summary.get("name")
    shard = room_summary.get("shard")
    if isinstance(name, str) and name:
        return name, shard if isinstance(shard, str) and shard else None

    room = room_summary.get("room")
    if isinstance(room, str):
        match = ROOM_RE.match(room)
        if match:
            return match.group("room"), match.group("shard")

    return None, None


def record_sort_key(record: ArtifactRecord) -> tuple[str, int, str, str]:
    tick = record.payload.get("tick")
    tick_text = f"{tick:020}" if isinstance(tick, int) else str(tick)
    return (
        record.source.display_path,
        record.line_number or 0,
        tick_text,
        canonical_hash(record.payload),
    )


def build_dataset(
    paths: Sequence[str],
    out_dir: Path,
    run_id: str | None = None,
    bot_commit: str | None = None,
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    sample_limit: int = DEFAULT_SAMPLE_LIMIT,
    eval_ratio_value: float = DEFAULT_EVAL_RATIO,
    split_seed: str = "screeps-rl-v1",
    repo_root: Path | None = None,
) -> JsonObject:
    repo = repo_root or Path.cwd()
    resolved_bot_commit = bot_commit or git_commit(repo)
    scan = collect_artifact_records(paths, max_file_bytes=max_file_bytes)
    rows = build_tick_rows(scan.records, resolved_bot_commit, sample_limit, eval_ratio_value, split_seed)
    resolved_run_id = run_id or deterministic_run_id(scan, rows, resolved_bot_commit, sample_limit, eval_ratio_value, split_seed)
    validate_run_id(resolved_run_id)

    run_dir = out_dir.expanduser() / resolved_run_id
    files = {
        "scenarioManifest": "scenario_manifest.json",
        "runManifest": "run_manifest.json",
        "sourceIndex": "source_index.json",
        "ticks": "ticks.ndjson",
        "kpiWindows": "kpi_windows.json",
        "episodes": "episodes.json",
        "datasetCard": "dataset_card.md",
    }

    runtime_lines = runtime_lines_from_records(scan.records)
    kpi_windows = reducer.reduce_runtime_kpis(runtime_lines)
    source_index = build_source_index(scan)
    split_counts = count_splits(rows)
    scenario_manifest = build_scenario_manifest(resolved_run_id, scan, resolved_bot_commit)
    episodes = build_episodes(resolved_run_id, rows, kpi_windows)
    run_manifest = build_run_manifest(
        run_id=resolved_run_id,
        bot_commit=resolved_bot_commit,
        scan=scan,
        rows=rows,
        split_counts=split_counts,
        split_seed=split_seed,
        eval_ratio_value=eval_ratio_value,
        files=files,
    )
    dataset_card = render_dataset_card(resolved_run_id, run_manifest, episodes)

    run_dir.mkdir(parents=True, exist_ok=True)
    write_json(run_dir / files["scenarioManifest"], scenario_manifest)
    write_json(run_dir / files["runManifest"], run_manifest)
    write_json(run_dir / files["sourceIndex"], source_index)
    write_ndjson(run_dir / files["ticks"], rows)
    write_json(run_dir / files["kpiWindows"], kpi_windows)
    write_json(run_dir / files["episodes"], episodes)
    write_text(run_dir / files["datasetCard"], dataset_card)
    assert_no_secret_leak(run_dir, configured_secret_values())

    return {
        "ok": True,
        "type": DATASET_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "runId": resolved_run_id,
        "outDir": display_path(run_dir),
        "sampleCount": len(rows),
        "sourceArtifactCount": len(scan.source_files),
        "runtimeSummaryArtifactCount": len(scan.records),
        "strategyShadowReportCount": len(scan.strategy_shadow_reports),
        "skippedFileCount": len(scan.skipped_files),
        "splitCounts": split_counts,
        "files": files,
    }


def build_tick_rows(
    records: Sequence[ArtifactRecord],
    bot_commit: str,
    sample_limit: int,
    eval_ratio_value: float,
    split_seed: str,
) -> list[JsonObject]:
    rows: list[JsonObject] = []
    for record_index, record in enumerate(records):
        payload = record.payload
        rooms = payload.get("rooms")
        if not isinstance(rooms, list):
            continue
        for room in sorted((item for item in rooms if isinstance(item, dict)), key=lambda item: str(item.get("roomName", ""))):
            room_name = room.get("roomName")
            if not isinstance(room_name, str) or not room_name:
                continue

            sample_id = build_sample_id(record, record_index, room_name)
            rows.append(
                {
                    "type": "screeps-rl-tick-sample",
                    "schemaVersion": SCHEMA_VERSION,
                    "sampleId": sample_id,
                    "botCommit": bot_commit,
                    "source": build_row_source(record),
                    "observation": build_observation(payload, room),
                    "actionLabels": build_action_labels(room),
                    "reward": build_reward(payload, room),
                    "split": assign_split(sample_id, split_seed, eval_ratio_value),
                    "safety": safety_notes(),
                }
            )
            if len(rows) >= sample_limit:
                return rows
    return rows


def build_sample_id(record: ArtifactRecord, record_index: int, room_name: str) -> str:
    source = {
        "sourceId": record.source.source_id,
        "lineNumber": record.line_number,
        "recordIndex": record_index,
        "roomName": room_name,
        "tick": record.payload.get("tick"),
        "artifactKind": record.artifact_kind,
    }
    return f"tick-{canonical_hash(source)[:16]}"


def build_row_source(record: ArtifactRecord) -> JsonObject:
    return {
        "sourceId": record.source.source_id,
        "artifactKind": record.artifact_kind,
        "path": record.source.display_path,
        "lineNumber": record.line_number,
        "sha256": record.source.sha256,
        "sizeBytes": record.source.size_bytes,
    }


def build_observation(payload: JsonObject, room: JsonObject) -> JsonObject:
    return {
        "tick": number_or_none(payload.get("tick")),
        "roomName": room.get("roomName"),
        **({"shard": room["shard"]} if isinstance(room.get("shard"), str) else {}),
        "energy": {
            "available": number_or_none(room.get("energyAvailable")),
            "capacity": number_or_none(room.get("energyCapacity")),
        },
        "workers": {
            "count": number_or_none(room.get("workerCount")),
            "taskCounts": select_number_map(room.get("taskCounts")),
        },
        "spawn": summarize_spawn(room.get("spawnStatus")),
        "controller": select_number_map(room.get("controller")),
        "resources": select_resource_observation(room.get("resources")),
        "combat": select_combat_observation(room.get("combat")),
        "cpu": select_number_map(payload.get("cpu")),
        "reliability": select_number_map(payload.get("reliability")),
        "monitor": select_number_map(room.get("monitor")),
    }


def summarize_spawn(raw_spawn_status: Any) -> JsonObject:
    if not isinstance(raw_spawn_status, list):
        return {"idleCount": None, "spawningCount": None, "total": None}
    idle = 0
    spawning = 0
    for item in raw_spawn_status:
        if not isinstance(item, dict):
            continue
        if item.get("status") == "idle":
            idle += 1
        if item.get("status") == "spawning":
            spawning += 1
    return {"idleCount": idle, "spawningCount": spawning, "total": idle + spawning}


def select_resource_observation(raw_resources: Any) -> JsonObject:
    resources = select_number_map(raw_resources)
    if isinstance(raw_resources, dict) and isinstance(raw_resources.get("productiveEnergy"), dict):
        resources["productiveEnergy"] = select_number_map(raw_resources["productiveEnergy"])
    if isinstance(raw_resources, dict) and isinstance(raw_resources.get("events"), dict):
        resources["events"] = select_number_map(raw_resources["events"])
    return resources


def select_combat_observation(raw_combat: Any) -> JsonObject:
    combat = select_number_map(raw_combat)
    if isinstance(raw_combat, dict) and isinstance(raw_combat.get("events"), dict):
        combat["events"] = select_number_map(raw_combat["events"])
    return combat


def build_action_labels(room: JsonObject) -> list[JsonObject]:
    labels: list[JsonObject] = []
    construction = room.get("constructionPriority")
    if isinstance(construction, dict) and isinstance(construction.get("nextPrimary"), dict):
        candidate = construction["nextPrimary"]
        if isinstance(candidate.get("buildItem"), str):
            labels.append(
                {
                    "surface": "construction-priority",
                    "sourceDecisionField": "constructionPriority.nextPrimary",
                    "registryFamily": "construction-priority",
                    "rolloutStatus": "offline-shadow-label",
                    "label": redact_text(candidate["buildItem"]),
                    "room": redact_text(candidate.get("room")) if isinstance(candidate.get("room"), str) else room.get("roomName"),
                    "score": number_or_none(candidate.get("score")),
                    "urgency": redact_text(candidate.get("urgency")) if isinstance(candidate.get("urgency"), str) else None,
                    "preconditions": string_list(candidate.get("preconditions")),
                    "expectedKpiMovement": string_list(candidate.get("expectedKpiMovement")),
                    "risks": string_list(candidate.get("risk")),
                    "liveEffect": False,
                }
            )

    territory = room.get("territoryRecommendation")
    if isinstance(territory, dict) and isinstance(territory.get("next"), dict):
        candidate = territory["next"]
        if isinstance(candidate.get("roomName"), str):
            action = redact_text(candidate.get("action")) if isinstance(candidate.get("action"), str) else "observe"
            labels.append(
                {
                    "surface": "expansion-remote-candidate",
                    "sourceDecisionField": "territoryRecommendation.next",
                    "registryFamily": "expansion-remote-candidate",
                    "rolloutStatus": "offline-shadow-label",
                    "label": action,
                    "targetRoom": redact_text(candidate["roomName"]),
                    "score": number_or_none(candidate.get("score")),
                    "evidenceStatus": redact_text(candidate.get("evidenceStatus"))
                    if isinstance(candidate.get("evidenceStatus"), str)
                    else None,
                    "source": redact_text(candidate.get("source")) if isinstance(candidate.get("source"), str) else None,
                    "preconditions": string_list(candidate.get("preconditions")),
                    "risks": string_list(candidate.get("risks")),
                    "routeDistance": number_or_none(candidate.get("routeDistance")),
                    "sourceCount": number_or_none(candidate.get("sourceCount")),
                    "hostileCreepCount": number_or_none(candidate.get("hostileCreepCount")),
                    "hostileStructureCount": number_or_none(candidate.get("hostileStructureCount")),
                    "liveEffect": False,
                }
            )

    return labels


def build_reward(payload: JsonObject, room: JsonObject) -> JsonObject:
    controller = room.get("controller") if isinstance(room.get("controller"), dict) else {}
    resources = room.get("resources") if isinstance(room.get("resources"), dict) else {}
    combat = room.get("combat") if isinstance(room.get("combat"), dict) else {}
    resource_events = resources.get("events") if isinstance(resources.get("events"), dict) else {}
    combat_events = combat.get("events") if isinstance(combat.get("events"), dict) else {}

    return {
        "status": "components-only",
        "scalarReward": None,
        "lexicographicOrder": ["reliability", "territory", "resources", "kills"],
        "components": {
            "reliability": {
                "loopExceptionCount": number_or_zero(nested_get(payload, ("reliability", "loopExceptionCount"))),
                "telemetrySilenceTicks": number_or_zero(nested_get(payload, ("reliability", "telemetrySilenceTicks"))),
                "cpuBucket": number_or_none(nested_get(payload, ("cpu", "bucket"))),
            },
            "territory": {
                "ownedRoomObserved": bool(room.get("roomName")),
                "controllerLevel": number_or_none(controller.get("level")),
                "controllerProgress": number_or_none(controller.get("progress")),
                "ticksToDowngrade": number_or_none(controller.get("ticksToDowngrade")),
            },
            "resources": {
                "storedEnergy": number_or_zero(resources.get("storedEnergy")),
                "workerCarriedEnergy": number_or_zero(resources.get("workerCarriedEnergy")),
                "droppedEnergy": number_or_zero(resources.get("droppedEnergy")),
                "harvestedEnergy": number_or_zero(resource_events.get("harvestedEnergy")),
                "transferredEnergy": number_or_zero(resource_events.get("transferredEnergy")),
            },
            "kills": {
                "hostileCreepCount": number_or_zero(combat.get("hostileCreepCount")),
                "hostileStructureCount": number_or_zero(combat.get("hostileStructureCount")),
                "attackDamage": number_or_zero(combat_events.get("attackDamage")),
                "objectDestroyedCount": number_or_zero(combat_events.get("objectDestroyedCount")),
                "creepDestroyedCount": number_or_zero(combat_events.get("creepDestroyedCount")),
            },
        },
        "notes": "Reward is an offline component label only; no scalar training objective is approved in this slice.",
    }


def nested_get(value: Any, keys: tuple[str, ...]) -> Any:
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def assign_split(sample_id: str, split_seed: str, eval_ratio_value: float) -> JsonObject:
    if eval_ratio_value <= 0:
        return {"name": "train", "method": "sha256-threshold", "seed": split_seed, "evalRatio": eval_ratio_value}
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


def safety_notes() -> JsonObject:
    return {
        "liveEffect": False,
        "allowedUse": "offline training/replay, shadow evaluation, and high-level recommendations only",
        "officialMmoControl": "forbidden until simulator evidence, historical MMO validation, KPI rollout gates, and rollback gates pass",
        "rawCreepIntentControl": False,
    }


def deterministic_run_id(
    scan: ScanResult,
    rows: Sequence[JsonObject],
    bot_commit: str,
    sample_limit: int,
    eval_ratio_value: float,
    split_seed: str,
) -> str:
    seed = {
        "schemaVersion": SCHEMA_VERSION,
        "botCommit": bot_commit,
        "sources": [
            {
                "sourceId": source.source_id,
                "sha256": source.sha256,
                "sizeBytes": source.size_bytes,
            }
            for source in sorted(scan.source_files.values(), key=lambda item: item.source_id)
        ],
        "records": [
            {
                "sourceId": record.source.source_id,
                "lineNumber": record.line_number,
                "artifactKind": record.artifact_kind,
                "tick": record.payload.get("tick"),
                "rooms": sorted(
                    room.get("roomName")
                    for room in record.payload.get("rooms", [])
                    if isinstance(room, dict) and isinstance(room.get("roomName"), str)
                ),
            }
            for record in scan.records
        ],
        "strategyShadowReports": scan.strategy_shadow_reports,
        "rowIds": [row["sampleId"] for row in rows],
        "sampleLimit": sample_limit,
        "evalRatio": eval_ratio_value,
        "splitSeed": split_seed,
    }
    return f"rl-{canonical_hash(seed)[:12]}"


def validate_run_id(run_id: str) -> None:
    if not RUN_ID_RE.fullmatch(run_id) or run_id in {".", ".."}:
        raise ValueError("run id may contain only letters, numbers, dot, underscore, and hyphen")


def runtime_lines_from_records(records: Sequence[ArtifactRecord]) -> list[str]:
    return [
        reducer.RUNTIME_SUMMARY_PREFIX + json.dumps(record.payload, sort_keys=True, separators=(",", ":")) + "\n"
        for record in records
    ]


def build_source_index(scan: ScanResult) -> JsonObject:
    return {
        "type": "screeps-rl-source-index",
        "schemaVersion": SCHEMA_VERSION,
        "inputPaths": redacted_input_paths(scan.input_paths),
        "scannedFiles": scan.scanned_files,
        "matchedArtifactCount": len(scan.records),
        "strategyShadowReportCount": len(scan.strategy_shadow_reports),
        "sourceFiles": [
            {
                "sourceId": source.source_id,
                "path": source.display_path,
                "sizeBytes": source.size_bytes,
                "sha256": source.sha256,
            }
            for source in sorted(scan.source_files.values(), key=lambda item: item.source_id)
        ],
        "strategyShadowReports": scan.strategy_shadow_reports,
        "skippedFiles": sorted(scan.skipped_files, key=lambda item: (item.get("path", ""), item.get("reason", ""))),
    }


def build_scenario_manifest(run_id: str, scan: ScanResult, bot_commit: str) -> JsonObject:
    return {
        "type": SCENARIO_MANIFEST_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "scenarioId": "historical-local-artifact-replay",
        "runId": run_id,
        "sourceMode": "historical-local-artifacts",
        "resettableSimulator": False,
        "liveSecretsRequired": False,
        "networkRequired": False,
        "officialMmoWritesAllowed": False,
        "botCommit": bot_commit,
        "sourceArtifactIds": sorted(scan.source_files.keys()),
        "notes": [
            "This first slice replays saved local runtime and monitor artifacts only.",
            "It is not a private-server simulator scenario and cannot authorize live policy control.",
        ],
    }


def build_episodes(run_id: str, rows: Sequence[JsonObject], kpi_windows: JsonObject) -> list[JsonObject]:
    first_tick = first_number([row["observation"].get("tick") for row in rows])
    latest_tick = latest_number([row["observation"].get("tick") for row in rows])
    rooms = sorted({row["observation"].get("roomName") for row in rows if isinstance(row["observation"].get("roomName"), str)})
    return [
        {
            "type": "screeps-rl-episode-summary",
            "schemaVersion": SCHEMA_VERSION,
            "episodeId": f"{run_id}:historical-window",
            "runId": run_id,
            "sampleCount": len(rows),
            "rooms": rooms,
            "window": {
                "firstTick": first_tick,
                "latestTick": latest_tick,
            },
            "kpiWindow": {
                "territoryStatus": nested_get(kpi_windows, ("territory", "status")),
                "resourcesStatus": nested_get(kpi_windows, ("resources", "status")),
                "combatStatus": nested_get(kpi_windows, ("combat", "status")),
            },
            "safetyGates": {
                "officialMmoEligible": False,
                "requiredBeforeLiveInfluence": [
                    "simulator evidence",
                    "historical MMO validation",
                    "KPI rollout gates",
                    "rollback gates",
                ],
            },
        }
    ]


def build_run_manifest(
    *,
    run_id: str,
    bot_commit: str,
    scan: ScanResult,
    rows: Sequence[JsonObject],
    split_counts: JsonObject,
    split_seed: str,
    eval_ratio_value: float,
    files: JsonObject,
) -> JsonObject:
    action_surfaces = sorted(
        {
            label["surface"]
            for row in rows
            for label in row.get("actionLabels", [])
            if isinstance(label, dict) and isinstance(label.get("surface"), str)
        }
    )
    return {
        "type": RUN_MANIFEST_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "runId": run_id,
        "botCommit": bot_commit,
        "source": {
            "inputPaths": redacted_input_paths(scan.input_paths),
            "scannedFiles": scan.scanned_files,
            "sourceArtifactCount": len(scan.source_files),
            "matchedArtifactCount": len(scan.records),
            "strategyShadowReportCount": len(scan.strategy_shadow_reports),
            "skippedFileCount": len(scan.skipped_files),
        },
        "strategy": {
            "registryPath": "prod/src/strategy/strategyRegistry.ts",
            "decisionSurfacesObserved": action_surfaces,
            "metadataAvailability": "runtime-summary decision fields when emitted",
            "shadowReports": scan.strategy_shadow_reports,
            "liveEffect": False,
        },
        "split": {
            "method": "sha256-threshold",
            "seed": split_seed,
            "evalRatio": eval_ratio_value,
            "counts": split_counts,
        },
        "sampleCount": len(rows),
        "storage": {
            "layout": "runtime-artifacts/rl-datasets/<run-id>/",
            "files": files,
        },
        "safety": safety_notes(),
        "retention": {
            "class": "local-derived-artifact",
            "rawSecretsPersisted": False,
            "redaction": "source content is not copied; selected fields are exported with secret-value redaction",
        },
    }


def render_dataset_card(run_id: str, run_manifest: JsonObject, episodes: list[JsonObject]) -> str:
    source = run_manifest["source"]
    split = run_manifest["split"]
    strategy = run_manifest["strategy"]
    episode = episodes[0] if episodes else {}
    rooms = ", ".join(episode.get("rooms", [])) if isinstance(episode.get("rooms"), list) else "none"
    surfaces = ", ".join(strategy["decisionSurfacesObserved"]) or "none observed"
    return "\n".join(
        [
            f"# RL Dataset Card: {run_id}",
            "",
            "## Intended Use",
            "",
            "Offline training/replay, shadow evaluation, and high-level recommendation analysis only.",
            "No learned policy output from this dataset is approved to directly control official MMO behavior.",
            "",
            "## Sources",
            "",
            f"- Source artifacts: {source['sourceArtifactCount']}",
            f"- Matched runtime/monitor artifacts: {source['matchedArtifactCount']}",
            f"- Scanned files: {source['scannedFiles']}",
            f"- Rooms: {rooms or 'none'}",
            "",
            "## Schema",
            "",
            "- `scenario_manifest.json`: historical local artifact replay manifest.",
            "- `run_manifest.json`: run ID, bot commit, source metadata, split metadata, and safety notes.",
            "- `source_index.json`: source path, size, and SHA-256 metadata without raw artifact contents.",
            "- `ticks.ndjson`: one observation/action-label/reward-component row per room tick sample.",
            "- `kpi_windows.json`: reducer output for the exported runtime-summary window.",
            "- `episodes.json`: episode-level window and gate summary.",
            "",
            "## Splits",
            "",
            f"- Method: {split['method']}",
            f"- Seed: {split['seed']}",
            f"- Eval ratio: {split['evalRatio']}",
            f"- Counts: {canonical_json(split['counts'])}",
            "",
            "## Strategy Metadata",
            "",
            f"- Registry path: {strategy['registryPath']}",
            f"- Decision surfaces observed: {surfaces}",
            "- Action labels are high-level recommendations copied from saved artifacts when present.",
            "",
            "## Redaction And Retention",
            "",
            "Raw artifact contents are not copied. The exporter writes selected numeric and high-level decision fields,",
            "source file hashes, and redacted display paths. Keep generated datasets in ignored local artifact storage",
            "unless a later review explicitly approves publishing a sanitized sample.",
            "",
            "## Safety Gates",
            "",
            "This dataset remains offline/shadow-only. Live influence requires simulator evidence, historical MMO",
            "validation, KPI rollout gates, and rollback gates.",
            "",
        ]
    )


def count_splits(rows: Sequence[JsonObject]) -> JsonObject:
    counts: dict[str, int] = {}
    for row in rows:
        split = nested_get(row, ("split", "name"))
        if isinstance(split, str):
            counts[split] = counts.get(split, 0) + 1
    return dict(sorted(counts.items()))


def write_json(path: Path, payload: Any) -> None:
    write_text(path, json.dumps(payload, indent=2, sort_keys=True) + "\n")


def write_ndjson(path: Path, rows: Sequence[JsonObject]) -> None:
    lines = [json.dumps(row, sort_keys=True, separators=(",", ":")) for row in rows]
    write_text(path, "\n".join(lines) + ("\n" if lines else ""))


def write_text(path: Path, content: str) -> None:
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


def assert_no_secret_leak(run_dir: Path, secrets: Sequence[str]) -> None:
    active_secrets = [secret for secret in secrets if secret and len(secret) >= 6]
    if not active_secrets:
        return
    for path in sorted(run_dir.iterdir(), key=lambda item: item.name):
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        for secret in active_secrets:
            if secret in text:
                shutil.rmtree(run_dir, ignore_errors=True)
                raise RuntimeError(f"refusing to persist dataset file containing a configured secret: {path.name}")


def select_number_map(raw: Any) -> JsonObject:
    if not isinstance(raw, dict):
        return {}
    return {str(key): value for key, value in sorted(raw.items()) if is_number(value)}


def string_list(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    values: list[str] = []
    for item in raw:
        if isinstance(item, str) and item:
            values.append(redact_text(item)[:240])
    return values


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def number_or_none(value: Any) -> int | float | None:
    return value if is_number(value) else None


def number_or_zero(value: Any) -> int | float:
    return value if is_number(value) else 0


def first_number(values: Iterable[Any]) -> int | float | None:
    for value in values:
        if is_number(value):
            return value
    return None


def latest_number(values: Iterable[Any]) -> int | float | None:
    latest: int | float | None = None
    for value in values:
        if is_number(value):
            latest = value
    return latest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build a deterministic offline RL dataset sample from saved local Screeps artifacts.",
    )
    parser.add_argument(
        "paths",
        nargs="*",
        help=(
            "Files or directories to scan. Defaults to /root/screeps/runtime-artifacts, "
            "/root/.hermes/cron/output, and repo-local runtime-artifacts."
        ),
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_OUT_DIR,
        help=f"Dataset root directory. Default: {DEFAULT_OUT_DIR}.",
    )
    parser.add_argument(
        "--run-id",
        help="Optional deterministic run directory name. Defaults to a content hash.",
    )
    parser.add_argument(
        "--bot-commit",
        help="Bot commit to record. Defaults to git rev-parse HEAD.",
    )
    parser.add_argument(
        "--max-file-bytes",
        type=positive_int,
        default=DEFAULT_MAX_FILE_BYTES,
        help=f"Skip files larger than this many bytes. Default: {DEFAULT_MAX_FILE_BYTES}.",
    )
    parser.add_argument(
        "--sample-limit",
        type=positive_int,
        default=DEFAULT_SAMPLE_LIMIT,
        help=f"Maximum tick samples to export. Default: {DEFAULT_SAMPLE_LIMIT}.",
    )
    parser.add_argument(
        "--eval-ratio",
        type=eval_ratio,
        default=DEFAULT_EVAL_RATIO,
        help=f"Deterministic eval split ratio. Default: {DEFAULT_EVAL_RATIO}.",
    )
    parser.add_argument(
        "--split-seed",
        default="screeps-rl-v1",
        help="Seed string for deterministic train/eval assignment.",
    )
    return parser


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout) -> int:
    args = build_parser().parse_args(argv)
    summary = build_dataset(
        args.paths,
        args.out_dir,
        run_id=args.run_id,
        bot_commit=args.bot_commit,
        max_file_bytes=args.max_file_bytes,
        sample_limit=args.sample_limit,
        eval_ratio_value=args.eval_ratio,
        split_seed=args.split_seed,
    )
    stdout.write(json.dumps(summary, indent=2, sort_keys=True))
    stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
