#!/usr/bin/env python3
"""Build a deterministic offline RL simulator-harness manifest."""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence, TextIO

import screeps_rl_dataset_export as dataset_export


SCHEMA_VERSION = 1
MANIFEST_TYPE = "screeps-rl-simulator-harness-manifest"
SUMMARY_TYPE = "screeps-rl-simulator-harness-generation"
DEFAULT_OUT_DIR = Path("runtime-artifacts/rl-simulator-harness")
DEFAULT_SEED = "screeps-rl-simulator-harness-v1"
DEFAULT_WORKERS = 4
DEFAULT_ROOMS_PER_WORKER = 4
DEFAULT_TARGET_SPEEDUP = 100.0
DEFAULT_OFFICIAL_TICK_SECONDS = 3.0

JsonObject = dict[str, Any]


@dataclass(frozen=True)
class ThroughputSample:
    worker_id: str
    room_ticks: int
    wall_seconds: float
    failure_count: int = 0


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def positive_float(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a number") from error
    if not math.isfinite(parsed) or parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than 0")
    return parsed


def non_negative_float(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a number") from error
    if not math.isfinite(parsed) or parsed < 0:
        raise argparse.ArgumentTypeError("must be at least 0")
    return parsed


def parse_throughput_sample(value: str) -> ThroughputSample:
    """Parse worker_id:room_ticks:wall_seconds[:failure_count]."""
    parts = value.split(":")
    if len(parts) not in {3, 4}:
        raise argparse.ArgumentTypeError(
            "throughput sample must be worker_id:room_ticks:wall_seconds[:failure_count]"
        )
    worker_id = parts[0].strip()
    if not worker_id:
        raise argparse.ArgumentTypeError("throughput sample worker_id may not be empty")
    try:
        room_ticks = int(parts[1])
        wall_seconds = float(parts[2])
        failure_count = int(parts[3]) if len(parts) == 4 else 0
    except ValueError as error:
        raise argparse.ArgumentTypeError("throughput sample has invalid numeric fields") from error
    if room_ticks <= 0:
        raise argparse.ArgumentTypeError("throughput sample room_ticks must be greater than 0")
    if not math.isfinite(wall_seconds) or wall_seconds <= 0:
        raise argparse.ArgumentTypeError("throughput sample wall_seconds must be greater than 0")
    if failure_count < 0:
        raise argparse.ArgumentTypeError("throughput sample failure_count must be at least 0")
    return ThroughputSample(
        worker_id=worker_id,
        room_ticks=room_ticks,
        wall_seconds=wall_seconds,
        failure_count=failure_count,
    )


def build_harness_manifest(
    paths: Sequence[str],
    out_dir: Path = DEFAULT_OUT_DIR,
    *,
    manifest_id: str | None = None,
    bot_commit: str | None = None,
    seed: str = DEFAULT_SEED,
    workers: int = DEFAULT_WORKERS,
    rooms_per_worker: int = DEFAULT_ROOMS_PER_WORKER,
    target_speedup: float = DEFAULT_TARGET_SPEEDUP,
    official_tick_seconds: float = DEFAULT_OFFICIAL_TICK_SECONDS,
    throughput_samples: Sequence[ThroughputSample] = (),
    estimated_worker_room_ticks_per_second: float = 0.0,
    max_file_bytes: int = dataset_export.DEFAULT_MAX_FILE_BYTES,
    repo_root: Path | None = None,
) -> JsonObject:
    repo = repo_root or Path.cwd()
    resolved_bot_commit = bot_commit or dataset_export.git_commit(repo)
    resolved_out_dir = out_dir.expanduser()
    scan = dataset_export.collect_artifact_records(
        paths,
        max_file_bytes=max_file_bytes,
        excluded_roots=[resolved_out_dir],
    )
    metadata = collect_local_metadata(scan)
    throughput = build_throughput_evidence(
        workers=workers,
        rooms_per_worker=rooms_per_worker,
        target_speedup=target_speedup,
        official_tick_seconds=official_tick_seconds,
        samples=throughput_samples,
        estimated_worker_room_ticks_per_second=estimated_worker_room_ticks_per_second,
    )
    seed_material = build_seed_material(
        scan=scan,
        metadata=metadata,
        bot_commit=resolved_bot_commit,
        seed=seed,
        workers=workers,
        rooms_per_worker=rooms_per_worker,
        target_speedup=target_speedup,
        official_tick_seconds=official_tick_seconds,
        throughput=throughput,
    )
    resolved_manifest_id = manifest_id or f"rl-sim-{dataset_export.canonical_hash(seed_material)[:12]}"
    validate_manifest_id(resolved_manifest_id)

    manifest = {
        "type": MANIFEST_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "manifestId": resolved_manifest_id,
        "owningIssue": "#414",
        "milestone": "P1: RL strategy flywheel gate",
        "roadmap": {
            "path": "docs/ops/rl-domain-roadmap.md",
            "lane": "L3 Simulator harness",
            "slice": "Slice B - simulator harness design-to-smoke",
        },
        "sourceMode": "local-artifact-metadata-only",
        "botCommit": resolved_bot_commit,
        "scenario": build_scenario_metadata(resolved_manifest_id, seed_material, scan, metadata),
        "adapterContract": adapter_contract(),
        "seed": build_seed_contract(seed, seed_material),
        "reset": build_reset_contract(seed_material),
        "workers": build_worker_contract(workers, rooms_per_worker),
        "throughput": throughput,
        "sources": build_source_metadata(scan, metadata),
        "datasets": metadata["datasets"],
        "strategyShadow": {
            "indexedReportCount": len(scan.strategy_shadow_reports),
            "reports": scan.strategy_shadow_reports,
            "generatedReports": metadata["strategyShadowReports"],
        },
        "privateSmoke": metadata["privateSmokeReports"],
        "safety": safety_metadata(),
        "retention": {
            "class": "local-derived-artifact",
            "rawRuntimeLogsCopied": False,
            "rawSecretsPersisted": False,
            "rawDatasetRowsCopied": False,
            "redaction": "only file hashes, counts, bounded report metadata, and redacted paths are persisted",
        },
    }
    assert_no_secret_leak(manifest, dataset_export.configured_secret_values())

    manifest_path = resolved_out_dir / resolved_manifest_id / "simulator_harness_manifest.json"
    write_json_atomic(manifest_path, manifest)
    return build_summary(manifest, manifest_path)


def build_seed_material(
    *,
    scan: dataset_export.ScanResult,
    metadata: JsonObject,
    bot_commit: str,
    seed: str,
    workers: int,
    rooms_per_worker: int,
    target_speedup: float,
    official_tick_seconds: float,
    throughput: JsonObject,
) -> JsonObject:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "botCommit": bot_commit,
        "seed": seed,
        "sourceFiles": [
            {
                "sourceId": source.source_id,
                "sha256": source.sha256,
                "sizeBytes": source.size_bytes,
            }
            for source in sorted(scan.source_files.values(), key=lambda item: item.source_id)
        ],
        "runtimeArtifacts": [
            runtime_artifact_ref(record)
            for record in sorted(scan.records, key=dataset_export.record_sort_key)
        ],
        "strategyShadowReports": scan.strategy_shadow_reports,
        "metadata": metadata,
        "workers": workers,
        "roomsPerWorker": rooms_per_worker,
        "targetSpeedup": target_speedup,
        "officialTickSeconds": official_tick_seconds,
        "throughput": throughput,
    }


def build_scenario_metadata(
    manifest_id: str,
    seed_material: JsonObject,
    scan: dataset_export.ScanResult,
    metadata: JsonObject,
) -> JsonObject:
    scenario_hash = dataset_export.canonical_hash(seed_material)
    return {
        "scenarioId": "local-artifact-seeded-private-simulator-smoke",
        "scenarioVersion": "0.1.0",
        "manifestId": manifest_id,
        "sourceMode": "runtime/dataset/shadow metadata seed",
        "resettableSimulatorTarget": True,
        "currentSliceExecutesSimulator": False,
        "currentSliceMode": "dry-run planning manifest",
        "determinismKey": scenario_hash,
        "runtimeArtifactCount": len(scan.records),
        "datasetRunCount": len(metadata["datasets"]["runManifests"]),
        "datasetScenarioCount": len(metadata["datasets"]["scenarioManifests"]),
        "strategyShadowReportCount": len(scan.strategy_shadow_reports),
        "generatedStrategyShadowReportCount": len(metadata["strategyShadowReports"]),
        "privateSmokeReportCount": len(metadata["privateSmokeReports"]),
        "notes": [
            "This slice does not start Docker, contact the official MMO, or execute learned policies.",
            "The manifest is the seed/reset/throughput contract for a later self-hosted private simulator adapter.",
        ],
    }


def build_seed_contract(seed: str, seed_material: JsonObject) -> JsonObject:
    root_hash = dataset_export.canonical_hash(seed_material)
    return {
        "baseSeed": dataset_export.redact_text(seed),
        "scenarioSeed": root_hash[:24],
        "seedDerivation": "sha256(canonical source metadata, bot commit, worker target, throughput input)",
        "streams": {
            "world": f"world-{dataset_export.canonical_hash({'root': root_hash, 'stream': 'world'})[:16]}",
            "workers": f"workers-{dataset_export.canonical_hash({'root': root_hash, 'stream': 'workers'})[:16]}",
            "episodes": f"episodes-{dataset_export.canonical_hash({'root': root_hash, 'stream': 'episodes'})[:16]}",
            "validation": f"validation-{dataset_export.canonical_hash({'root': root_hash, 'stream': 'validation'})[:16]}",
        },
    }


def build_reset_contract(seed_material: JsonObject) -> JsonObject:
    reset_hash = dataset_export.canonical_hash({"reset": seed_material})
    return {
        "resetId": f"reset-{reset_hash[:16]}",
        "method": "atomic private-server world reset target",
        "idempotenceKey": reset_hash,
        "requiredInputs": [
            "scenario manifest",
            "scenario seed",
            "bot bundle commit",
            "strategy registry version",
            "memory/raw-memory fixture digest",
            "private-server package/container versions",
        ],
        "dryRunEvidence": {
            "resetExecuted": False,
            "reason": "first #414 slice records the reset contract without requiring Docker or secrets",
        },
    }


def build_worker_contract(workers: int, rooms_per_worker: int) -> JsonObject:
    return {
        "plannedWorkerCount": workers,
        "plannedRoomsPerWorker": rooms_per_worker,
        "plannedParallelRoomCount": workers * rooms_per_worker,
        "isolation": "one private-server worker process per worker index",
        "vectorization": "one or more scenario rooms per worker process",
        "workerIndexSeedPolicy": "derive worker seed stream from base scenario seed plus worker index",
        "healthRequired": [
            "process alive",
            "local control API responsive",
            "active scenario matches manifest",
            "failure count reported",
            "room tick counter increasing during run",
        ],
    }


def build_throughput_evidence(
    *,
    workers: int,
    rooms_per_worker: int,
    target_speedup: float,
    official_tick_seconds: float,
    samples: Sequence[ThroughputSample],
    estimated_worker_room_ticks_per_second: float,
) -> JsonObject:
    target_room_ticks_per_second = target_speedup / official_tick_seconds
    target = {
        "officialTickSecondsBaseline": official_tick_seconds,
        "targetSpeedupVsOfficial": target_speedup,
        "targetAggregateRoomTicksPerSecond": round(target_room_ticks_per_second, 6),
        "plannedWorkerCount": workers,
        "plannedRoomsPerWorker": rooms_per_worker,
        "plannedParallelRoomCount": workers * rooms_per_worker,
    }
    if samples:
        total_room_ticks = sum(sample.room_ticks for sample in samples)
        max_wall_seconds = max(sample.wall_seconds for sample in samples)
        aggregate_rps = total_room_ticks / max_wall_seconds if max_wall_seconds > 0 else 0.0
        failure_count = sum(sample.failure_count for sample in samples)
        mode = "sampled-dry-run-input"
        sample_rows = [
            {
                "workerId": dataset_export.redact_text(sample.worker_id),
                "roomTicks": sample.room_ticks,
                "wallSeconds": sample.wall_seconds,
                "failureCount": sample.failure_count,
                "roomTicksPerSecond": round(sample.room_ticks / sample.wall_seconds, 6),
            }
            for sample in samples
        ]
    elif estimated_worker_room_ticks_per_second > 0:
        total_room_ticks = None
        max_wall_seconds = None
        aggregate_rps = estimated_worker_room_ticks_per_second * workers
        failure_count = None
        mode = "estimated-from-worker-rate"
        sample_rows = []
    else:
        total_room_ticks = None
        max_wall_seconds = None
        aggregate_rps = None
        failure_count = None
        mode = "not-measured"
        sample_rows = []

    speedup = aggregate_rps * official_tick_seconds if aggregate_rps is not None else None
    gap = target_room_ticks_per_second - aggregate_rps if aggregate_rps is not None else None
    return {
        "target": target,
        "evidenceMode": mode,
        "samples": sample_rows,
        "aggregate": {
            "totalRoomTicks": total_room_ticks,
            "parallelWallSeconds": max_wall_seconds,
            "aggregateRoomTicksPerSecond": round(aggregate_rps, 6) if aggregate_rps is not None else None,
            "speedupVsOfficial": round(speedup, 6) if speedup is not None else None,
            "targetMet": bool(speedup is not None and speedup >= target_speedup),
            "gapRoomTicksPerSecond": round(gap, 6) if gap is not None and gap > 0 else 0,
            "failureCount": failure_count,
        },
        "bottleneckPolicy": (
            "If the sampled aggregate rate is below target, report bottlenecks and scale workers or rooms per "
            "worker instead of weakening Screeps mechanics."
        ),
    }


def collect_local_metadata(scan: dataset_export.ScanResult) -> JsonObject:
    metadata: JsonObject = {
        "datasets": {
            "runManifests": [],
            "scenarioManifests": [],
            "sourceIndexes": [],
            "exportSummaries": [],
        },
        "strategyShadowReports": [],
        "privateSmokeReports": [],
    }
    for source in sorted(scan.source_files.values(), key=lambda item: item.source_id):
        try:
            text = Path(source.path).read_text(encoding="utf-8")
        except OSError:
            continue
        for line_number, document in dataset_export.iter_json_documents(text):
            for item in dataset_export.flatten_json_documents(document):
                if not isinstance(item, dict):
                    continue
                append_dataset_metadata(metadata, source, line_number, item)
                shadow = generated_shadow_report_metadata(item, source, line_number)
                if shadow is not None:
                    metadata["strategyShadowReports"].append(shadow)
                smoke = private_smoke_report_metadata(item, source, line_number)
                if smoke is not None:
                    metadata["privateSmokeReports"].append(smoke)

    for key in metadata["datasets"]:
        metadata["datasets"][key].sort(key=lambda item: metadata_sort_key(item, "runId"))
    metadata["strategyShadowReports"].sort(key=lambda item: metadata_sort_key(item, "reportId"))
    metadata["privateSmokeReports"].sort(key=lambda item: metadata_sort_key(item, "workDir"))
    return metadata


def metadata_sort_key(item: JsonObject, id_key: str) -> tuple[str, str]:
    return (sort_text(item.get("path")), sort_text(item.get(id_key)))


def sort_text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def append_dataset_metadata(
    metadata: JsonObject,
    source: dataset_export.SourceFile,
    line_number: int | None,
    raw: JsonObject,
) -> None:
    common = source_common(source, line_number)
    raw_type = raw.get("type")
    if raw_type == dataset_export.RUN_MANIFEST_TYPE:
        strategy = raw.get("strategy") if isinstance(raw.get("strategy"), dict) else {}
        source_meta = raw.get("source") if isinstance(raw.get("source"), dict) else {}
        split = raw.get("split") if isinstance(raw.get("split"), dict) else {}
        metadata["datasets"]["runManifests"].append(
            {
                **common,
                "runId": text_or_none(raw.get("runId")),
                "botCommit": text_or_none(raw.get("botCommit")),
                "sampleCount": number_or_none(raw.get("sampleCount")),
                "sourceArtifactCount": number_or_none(source_meta.get("sourceArtifactCount")),
                "matchedArtifactCount": number_or_none(source_meta.get("matchedArtifactCount")),
                "strategyShadowReportCount": number_or_none(source_meta.get("strategyShadowReportCount")),
                "decisionSurfacesObserved": string_list(strategy.get("decisionSurfacesObserved")),
                "liveEffect": strategy.get("liveEffect") is True,
                "splitSeed": text_or_none(split.get("seed")),
                "splitCounts": select_number_map(split.get("counts")),
            }
        )
        return

    if raw_type == dataset_export.SCENARIO_MANIFEST_TYPE:
        source_artifact_ids = raw.get("sourceArtifactIds")
        metadata["datasets"]["scenarioManifests"].append(
            {
                **common,
                "runId": text_or_none(raw.get("runId")),
                "scenarioId": text_or_none(raw.get("scenarioId")),
                "sourceMode": text_or_none(raw.get("sourceMode")),
                "resettableSimulator": raw.get("resettableSimulator") is True,
                "networkRequired": raw.get("networkRequired") is True,
                "officialMmoWritesAllowed": raw.get("officialMmoWritesAllowed") is True,
                "sourceArtifactCount": len(source_artifact_ids) if isinstance(source_artifact_ids, list) else None,
            }
        )
        return

    if raw_type == "screeps-rl-source-index":
        source_files = raw.get("sourceFiles")
        metadata["datasets"]["sourceIndexes"].append(
            {
                **common,
                "inputPaths": string_list(raw.get("inputPaths")),
                "sourceFileCount": len(source_files) if isinstance(source_files, list) else None,
                "scannedFiles": number_or_none(raw.get("scannedFiles")),
                "matchedArtifactCount": number_or_none(raw.get("matchedArtifactCount")),
                "strategyShadowReportCount": number_or_none(raw.get("strategyShadowReportCount")),
                "skippedFileCount": len(raw.get("skippedFiles")) if isinstance(raw.get("skippedFiles"), list) else None,
            }
        )
        return

    if raw_type == dataset_export.DATASET_TYPE:
        metadata["datasets"]["exportSummaries"].append(
            {
                **common,
                "runId": text_or_none(raw.get("runId")),
                "sampleCount": number_or_none(raw.get("sampleCount")),
                "sourceArtifactCount": number_or_none(raw.get("sourceArtifactCount")),
                "runtimeSummaryArtifactCount": number_or_none(raw.get("runtimeSummaryArtifactCount")),
                "strategyShadowReportCount": number_or_none(raw.get("strategyShadowReportCount")),
                "splitCounts": select_number_map(raw.get("splitCounts")),
            }
        )


def generated_shadow_report_metadata(
    raw: JsonObject,
    source: dataset_export.SourceFile,
    line_number: int | None,
) -> JsonObject | None:
    if raw.get("type") != "screeps-strategy-shadow-report":
        return None
    return {
        **source_common(source, line_number),
        "reportId": text_or_none(raw.get("reportId")),
        "enabled": raw.get("enabled") is True,
        "liveEffect": raw.get("liveEffect") is True,
        "artifactCount": number_or_none(raw.get("artifactCount")),
        "modelReportCount": number_or_none(raw.get("modelReportCount")),
        "rankingDiffCount": number_or_none(raw.get("rankingDiffCount")),
        "changedTopCount": number_or_none(raw.get("changedTopCount")),
        "candidateStrategyIds": string_list(raw.get("candidateStrategyIds")),
        "incumbentStrategyIds": string_list(raw.get("incumbentStrategyIds")),
        "modelFamilies": string_list(raw.get("modelFamilies")),
    }


def private_smoke_report_metadata(
    raw: JsonObject,
    source: dataset_export.SourceFile,
    line_number: int | None,
) -> JsonObject | None:
    if not isinstance(raw.get("dry_run"), bool) or not isinstance(raw.get("ports"), dict):
        return None
    smoke = raw.get("smoke") if isinstance(raw.get("smoke"), dict) else {}
    ports = raw.get("ports") if isinstance(raw.get("ports"), dict) else {}
    return {
        **source_common(source, line_number),
        "ok": raw.get("ok") is True,
        "dryRun": raw.get("dry_run") is True,
        "workDir": text_or_none(raw.get("work_dir")),
        "composeProject": text_or_none(raw.get("compose_project")),
        "room": text_or_none(smoke.get("room")),
        "shard": text_or_none(smoke.get("shard")),
        "hostPorts": select_number_map(ports.get("host")),
        "containerPorts": select_number_map(ports.get("container")),
    }


def build_source_metadata(scan: dataset_export.ScanResult, metadata: JsonObject) -> JsonObject:
    runtime_counts: dict[str, int] = {}
    artifact_kinds: dict[str, set[str]] = {}
    for record in scan.records:
        runtime_counts[record.source.source_id] = runtime_counts.get(record.source.source_id, 0) + 1
        artifact_kinds.setdefault(record.source.source_id, set()).add(record.artifact_kind)

    dataset_sources = metadata_sources(metadata)
    runtime_artifacts = [runtime_artifact_ref(record) for record in sorted(scan.records, key=dataset_export.record_sort_key)]
    source_files = []
    for source in sorted(scan.source_files.values(), key=lambda item: item.source_id):
        kinds = sorted(artifact_kinds.get(source.source_id, set()) | dataset_sources.get(source.source_id, set()))
        source_files.append(
            {
                "sourceId": source.source_id,
                "path": source.display_path,
                "sizeBytes": source.size_bytes,
                "sha256": source.sha256,
                "runtimeArtifactCount": runtime_counts.get(source.source_id, 0),
                "metadataKinds": kinds,
            }
        )
    return {
        "inputPaths": dataset_export.redacted_input_paths(scan.input_paths),
        "scannedFiles": scan.scanned_files,
        "sourceFileCount": len(scan.source_files),
        "runtimeArtifactCount": len(scan.records),
        "strategyShadowReportCount": len(scan.strategy_shadow_reports),
        "skippedFileCount": len(scan.skipped_files),
        "skippedFiles": sanitize_skipped_files(scan.skipped_files),
        "sourceFiles": source_files,
        "runtimeArtifacts": runtime_artifacts,
    }


def metadata_sources(metadata: JsonObject) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for kind, items in metadata["datasets"].items():
        for item in items:
            source_id = item.get("sourceId")
            if isinstance(source_id, str):
                result.setdefault(source_id, set()).add(kind)
    for kind in ("strategyShadowReports", "privateSmokeReports"):
        for item in metadata[kind]:
            source_id = item.get("sourceId")
            if isinstance(source_id, str):
                result.setdefault(source_id, set()).add(kind)
    return result


def runtime_artifact_ref(record: dataset_export.ArtifactRecord) -> JsonObject:
    payload = record.payload
    rooms = payload.get("rooms") if isinstance(payload.get("rooms"), list) else []
    room_names = sorted(
        room.get("roomName")
        for room in rooms
        if isinstance(room, dict) and isinstance(room.get("roomName"), str)
    )
    return {
        "artifactId": f"runtime-{dataset_export.canonical_hash(payload)[:16]}",
        "sourceId": record.source.source_id,
        "artifactKind": record.artifact_kind,
        "path": record.source.display_path,
        "lineNumber": record.line_number,
        "tick": number_or_none(payload.get("tick")),
        "roomCount": len(room_names),
        "rooms": room_names,
    }


def adapter_contract() -> JsonObject:
    return {
        "apiVersion": "screeps-rl-sim-adapter.v1alpha1",
        "transport": "local JSON over stdio or loopback HTTP",
        "officialMmoApiExposed": False,
        "methods": {
            "health": "worker status, package versions, active scenario, tick, pid, and failure counters",
            "loadScenario": "load a deterministic scenario manifest without ticking",
            "reset": "atomically reset world state from seed, bot bundle, memory snapshot, and strategy version",
            "step": "advance a bounded number of private-server ticks with typed offline recommendations",
            "observe": "read room objects, terrain, event logs, memory summaries, CPU stats, and KPI reducers",
            "artifact": "export scenario config, seed, observations, actions, rewards, logs, KPI output, and throughput",
            "close": "stop worker-owned processes and verify cleanup",
        },
        "allowedActionSurface": [
            "construction_preset",
            "remote_target",
            "expansion_candidate",
            "defense_posture",
            "weight_vector",
        ],
        "forbiddenActionSurface": [
            "official MMO writes",
            "RawMemory commands to official MMO",
            "raw creep intents",
            "spawn intents",
            "market orders",
        ],
    }


def safety_metadata() -> JsonObject:
    return {
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "officialMmoControl": False,
        "networkRequired": False,
        "dockerRequired": False,
        "liveSecretsRequired": False,
        "rawCreepIntentControl": False,
        "memoryWritesAllowed": False,
        "rawMemoryWritesAllowed": False,
        "allowedUse": "offline/private simulator planning, shadow evaluation, and high-level recommendations only",
        "requiredBeforeLiveInfluence": [
            "simulator evidence",
            "historical official-MMO validation",
            "private/shadow safety gate",
            "KPI rollout gate",
            "rollback gate",
        ],
    }


def build_summary(manifest: JsonObject, manifest_path: Path) -> JsonObject:
    source = manifest["sources"]
    throughput = manifest["throughput"]
    return {
        "ok": True,
        "type": SUMMARY_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "manifestId": manifest["manifestId"],
        "manifestPath": dataset_export.display_path(manifest_path),
        "liveEffect": False,
        "officialMmoWrites": False,
        "sourceFileCount": source["sourceFileCount"],
        "runtimeArtifactCount": source["runtimeArtifactCount"],
        "datasetRunCount": manifest["scenario"]["datasetRunCount"],
        "strategyShadowReportCount": manifest["scenario"]["strategyShadowReportCount"],
        "throughput": {
            "evidenceMode": throughput["evidenceMode"],
            "aggregateRoomTicksPerSecond": throughput["aggregate"]["aggregateRoomTicksPerSecond"],
            "speedupVsOfficial": throughput["aggregate"]["speedupVsOfficial"],
            "targetMet": throughput["aggregate"]["targetMet"],
        },
        "safety": manifest["safety"],
    }


def source_common(source: dataset_export.SourceFile, line_number: int | None) -> JsonObject:
    return {
        "sourceId": source.source_id,
        "path": source.display_path,
        "lineNumber": line_number,
        "sha256": source.sha256,
        "sizeBytes": source.size_bytes,
    }


def sanitize_skipped_files(skipped_files: Sequence[JsonObject], limit: int = 20) -> list[JsonObject]:
    sanitized: list[JsonObject] = []
    for item in skipped_files[:limit]:
        sanitized_item: JsonObject = {}
        for key, value in item.items():
            if isinstance(value, str):
                sanitized_item[str(key)] = dataset_export.redact_text(value)[:240]
            elif isinstance(value, (int, float, bool)) or value is None:
                sanitized_item[str(key)] = value
        sanitized.append(sanitized_item)
    return sanitized


def validate_manifest_id(manifest_id: str) -> None:
    dataset_export.validate_run_id(manifest_id)


def text_or_none(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    return dataset_export.redact_text(value)[:240]


def string_list(raw: Any, limit: int = 50) -> list[str]:
    if not isinstance(raw, list):
        return []
    result: list[str] = []
    for item in raw[:limit]:
        if isinstance(item, str):
            result.append(dataset_export.redact_text(item)[:240])
    return result


def select_number_map(raw: Any) -> JsonObject:
    if not isinstance(raw, dict):
        return {}
    return {str(key): value for key, value in sorted(raw.items()) if dataset_export.is_number(value)}


def number_or_none(value: Any) -> int | float | None:
    return value if dataset_export.is_number(value) else None


def assert_no_secret_leak(payload: JsonObject, secrets: Sequence[str]) -> None:
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=True)
    for secret in secrets:
        if secret and len(secret) >= 6 and secret in encoded:
            raise RuntimeError("refusing to persist simulator harness manifest containing a configured secret")


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(temp_fd, "w", encoding="utf-8") as handle:
            temp_fd = -1
            handle.write(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True))
            handle.write("\n")
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


def run_self_test(stdout: TextIO = sys.stdout) -> int:
    payload = {
        "type": "runtime-summary",
        "tick": 100,
        "rooms": [{"roomName": "W1N1", "workerCount": 2, "resources": {"storedEnergy": 100}}],
    }
    shadow_report = {
        "type": "screeps-strategy-shadow-report",
        "reportId": "self-test-shadow",
        "enabled": True,
        "liveEffect": False,
        "artifactCount": 1,
        "modelReportCount": 1,
        "rankingDiffCount": 1,
        "changedTopCount": 0,
        "candidateStrategyIds": ["construction-priority.territory-shadow.v1"],
        "modelFamilies": ["construction-priority"],
        "modelReports": [],
    }
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        runtime = root / "runtime.log"
        shadow = root / "shadow.json"
        runtime.write_text(
            "#runtime-summary " + json.dumps(payload, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        shadow.write_text(json.dumps(shadow_report, sort_keys=True), encoding="utf-8")
        summary = build_harness_manifest(
            [str(runtime), str(shadow)],
            root / "out",
            manifest_id="self-test",
            bot_commit="0" * 40,
            throughput_samples=[ThroughputSample("worker-0", 1200, 30.0)],
        )
        if not summary["ok"] or summary["liveEffect"] or summary["officialMmoWrites"]:
            raise RuntimeError("self-test safety summary failed")
        if summary["runtimeArtifactCount"] != 1 or summary["strategyShadowReportCount"] < 1:
            raise RuntimeError("self-test source summary failed")
    stdout.write(json.dumps(summary, indent=2, sort_keys=True, ensure_ascii=True))
    stdout.write("\n")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build an offline Screeps RL simulator-harness planning manifest.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    dry = subparsers.add_parser(
        "dry-run",
        help="Generate a deterministic manifest without Docker, network, secrets, or official MMO writes.",
    )
    dry.add_argument(
        "paths",
        nargs="*",
        help=(
            "Files or directories to scan. Defaults to /root/screeps/runtime-artifacts, "
            "/root/.hermes/cron/output, and repo-local runtime-artifacts."
        ),
    )
    dry.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_OUT_DIR,
        help=f"Manifest output root. Default: {DEFAULT_OUT_DIR}.",
    )
    dry.add_argument("--manifest-id", help="Optional manifest directory name. Defaults to a content hash.")
    dry.add_argument("--bot-commit", help="Bot commit to record. Defaults to git rev-parse HEAD.")
    dry.add_argument("--seed", default=DEFAULT_SEED, help=f"Base deterministic seed. Default: {DEFAULT_SEED}.")
    dry.add_argument(
        "--workers",
        type=positive_int,
        default=DEFAULT_WORKERS,
        help=f"Planned worker count. Default: {DEFAULT_WORKERS}.",
    )
    dry.add_argument(
        "--rooms-per-worker",
        type=positive_int,
        default=DEFAULT_ROOMS_PER_WORKER,
        help=f"Planned vectorized rooms per worker. Default: {DEFAULT_ROOMS_PER_WORKER}.",
    )
    dry.add_argument(
        "--target-speedup",
        type=positive_float,
        default=DEFAULT_TARGET_SPEEDUP,
        help=f"Aggregate target versus official tick speed. Default: {DEFAULT_TARGET_SPEEDUP}.",
    )
    dry.add_argument(
        "--official-tick-seconds",
        type=positive_float,
        default=DEFAULT_OFFICIAL_TICK_SECONDS,
        help=f"Official tick baseline used for speedup math. Default: {DEFAULT_OFFICIAL_TICK_SECONDS}.",
    )
    dry.add_argument(
        "--estimate-worker-room-ticks-per-second",
        type=non_negative_float,
        default=0.0,
        help="Optional dry-run estimate per worker when no samples are supplied.",
    )
    dry.add_argument(
        "--throughput-sample",
        action="append",
        default=[],
        type=parse_throughput_sample,
        help="Worker sample as worker_id:room_ticks:wall_seconds[:failure_count]. Repeat per worker.",
    )
    dry.add_argument(
        "--max-file-bytes",
        type=positive_int,
        default=dataset_export.DEFAULT_MAX_FILE_BYTES,
        help=f"Skip input files larger than this many bytes. Default: {dataset_export.DEFAULT_MAX_FILE_BYTES}.",
    )

    subparsers.add_parser("self-test", help="Run a no-network/no-Docker manifest generation self-test.")
    return parser


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "self-test":
        return run_self_test(stdout)
    if args.command == "dry-run":
        summary = build_harness_manifest(
            args.paths,
            args.out_dir,
            manifest_id=args.manifest_id,
            bot_commit=args.bot_commit,
            seed=args.seed,
            workers=args.workers,
            rooms_per_worker=args.rooms_per_worker,
            target_speedup=args.target_speedup,
            official_tick_seconds=args.official_tick_seconds,
            throughput_samples=args.throughput_sample,
            estimated_worker_room_ticks_per_second=args.estimate_worker_room_ticks_per_second,
            max_file_bytes=args.max_file_bytes,
        )
        stdout.write(json.dumps(summary, indent=2, sort_keys=True, ensure_ascii=True))
        stdout.write("\n")
        return 0
    raise AssertionError(f"unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
