#!/usr/bin/env python3
"""Train a shadow worker-task behavioral cloning policy from runtime summaries."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import sys
import tempfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import screeps_rl_dataset_export as dataset_export


SCHEMA_VERSION = 1
MODEL_TYPE = "worker-task-bc-decision-tree"
REPORT_TYPE = "worker-task-bc-evaluation-report"
DEFAULT_OUT_DIR = Path("runtime-artifacts/worker-task-bc")
DEFAULT_SAMPLE_LIMIT = 50_000
DEFAULT_EVAL_RATIO = 0.2
DEFAULT_MAX_DEPTH = 5
DEFAULT_MIN_SAMPLES_SPLIT = 8
DEFAULT_MIN_CONFIDENCE = 0.9
ACTION_TYPES = ("harvest", "transfer", "build", "repair", "upgrade")
FEATURES = (
    "x",
    "y",
    "carriedEnergy",
    "freeCapacity",
    "energyCapacity",
    "energyLoadRatio",
    "currentTaskCode",
    "roomEnergyAvailable",
    "roomEnergyCapacity",
    "workerCount",
    "spawnExtensionNeedCount",
    "towerNeedCount",
    "constructionSiteCount",
    "repairTargetCount",
    "sourceCount",
    "hasContainerEnergy",
    "containerEnergyAvailable",
    "droppedEnergyAvailable",
    "nearbyRoadCount",
    "nearbyContainerCount",
    "roadCoverage",
    "hostileCreepCount",
    "controllerLevel",
    "controllerTicksToDowngrade",
    "controllerProgressRatio",
)
RUN_ID_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-")

JsonObject = dict[str, Any]
TreeNode = JsonObject


@dataclass(frozen=True)
class BehaviorSample:
    sample_id: str
    source_id: str
    room_name: str
    tick: int | None
    creep_name: str | None
    state: JsonObject
    action: str


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def ratio(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a number") from error
    if parsed < 0 or parsed >= 1:
        raise argparse.ArgumentTypeError("must be at least 0 and less than 1")
    return parsed


def probability(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a number") from error
    if parsed < 0 or parsed > 1:
        raise argparse.ArgumentTypeError("must be between 0 and 1")
    return parsed


def extract_behavior_samples(
    paths: Sequence[str],
    max_file_bytes: int = dataset_export.DEFAULT_MAX_FILE_BYTES,
    sample_limit: int = DEFAULT_SAMPLE_LIMIT,
) -> list[BehaviorSample]:
    scan = dataset_export.collect_artifact_records(paths, max_file_bytes=max_file_bytes)
    samples: list[BehaviorSample] = []

    for record_index, record in enumerate(scan.records):
        rooms = record.payload.get("rooms")
        if not isinstance(rooms, list):
            continue
        for room in rooms:
            if not isinstance(room, dict):
                continue
            room_name = room.get("roomName")
            if not isinstance(room_name, str) or not room_name:
                continue
            samples.extend(extract_room_behavior_samples(record, record_index, room, room_name, sample_limit))
            if len(samples) >= sample_limit:
                return samples[:sample_limit]

    return samples[:sample_limit]


def extract_room_behavior_samples(
    record: dataset_export.ArtifactRecord,
    record_index: int,
    room: JsonObject,
    room_name: str,
    sample_limit: int,
) -> list[BehaviorSample]:
    behavior = room.get("behavior")
    if not isinstance(behavior, dict):
        return []
    worker_policy = behavior.get("workerTaskPolicy")
    if not isinstance(worker_policy, dict):
        return []
    raw_samples = worker_policy.get("samples")
    if not isinstance(raw_samples, list):
        return []

    samples: list[BehaviorSample] = []
    for sample_index, raw_sample in enumerate(raw_samples):
        parsed = parse_behavior_sample(
            record=record,
            record_index=record_index,
            room_name=room_name,
            sample_index=sample_index,
            raw_sample=raw_sample,
        )
        if parsed is not None:
            samples.append(parsed)
        if len(samples) >= sample_limit:
            break

    return samples


def parse_behavior_sample(
    *,
    record: dataset_export.ArtifactRecord,
    record_index: int,
    room_name: str,
    sample_index: int,
    raw_sample: Any,
) -> BehaviorSample | None:
    if not isinstance(raw_sample, dict) or raw_sample.get("liveEffect") is not False:
        return None
    state = raw_sample.get("state")
    action = raw_sample.get("action")
    if not isinstance(state, dict) or not isinstance(action, dict):
        return None
    action_type = action.get("type")
    if action_type not in ACTION_TYPES:
        return None
    tick = raw_sample.get("tick")
    creep_name = raw_sample.get("creepName")
    sample_seed = {
        "sourceId": record.source.source_id,
        "recordIndex": record_index,
        "lineNumber": record.line_number,
        "roomName": room_name,
        "sampleIndex": sample_index,
        "tick": tick,
        "creepName": creep_name,
        "action": action_type,
    }
    return BehaviorSample(
        sample_id=f"worker-bc-{canonical_hash(sample_seed)[:16]}",
        source_id=record.source.source_id,
        room_name=room_name,
        tick=int(tick) if isinstance(tick, int) else None,
        creep_name=creep_name if isinstance(creep_name, str) else None,
        state=state,
        action=action_type,
    )


def train_decision_tree(
    samples: Sequence[BehaviorSample],
    features: Sequence[str] = FEATURES,
    max_depth: int = DEFAULT_MAX_DEPTH,
    min_samples_split: int = DEFAULT_MIN_SAMPLES_SPLIT,
) -> TreeNode | None:
    if not samples:
        return None
    return build_tree(list(samples), tuple(features), max_depth, min_samples_split, depth=0)


def build_tree(
    samples: list[BehaviorSample],
    features: tuple[str, ...],
    max_depth: int,
    min_samples_split: int,
    depth: int,
) -> TreeNode:
    distribution = action_distribution(samples)
    if depth >= max_depth or len(samples) < min_samples_split or len(distribution) <= 1:
        return leaf_node(distribution)

    split = find_best_split(samples, features)
    if split is None:
        return leaf_node(distribution)

    feature, threshold, missing_side, left, right = split
    return {
        "type": "branch",
        "feature": feature,
        "threshold": round(threshold, 6),
        "missing": missing_side,
        "sampleCount": len(samples),
        "distribution": dict(sorted(distribution.items())),
        "left": build_tree(left, features, max_depth, min_samples_split, depth + 1),
        "right": build_tree(right, features, max_depth, min_samples_split, depth + 1),
    }


def find_best_split(
    samples: list[BehaviorSample],
    features: tuple[str, ...],
) -> tuple[str, float, str, list[BehaviorSample], list[BehaviorSample]] | None:
    base_impurity = gini(samples)
    best_gain = 0.0
    best_split: tuple[str, float, str, list[BehaviorSample], list[BehaviorSample]] | None = None

    for feature in features:
        thresholds = candidate_thresholds(samples, feature)
        for threshold in thresholds:
            for missing_side in ("left", "right"):
                left, right = partition_samples(samples, feature, threshold, missing_side)
                if not left or not right:
                    continue
                impurity = weighted_gini(left, right)
                gain = base_impurity - impurity
                if gain > best_gain:
                    best_gain = gain
                    best_split = (feature, threshold, missing_side, left, right)

    return best_split


def candidate_thresholds(samples: Sequence[BehaviorSample], feature: str) -> list[float]:
    values = sorted({value for sample in samples if (value := feature_value(sample.state, feature)) is not None})
    if len(values) <= 1:
        return []
    mids = [(left + right) / 2 for left, right in zip(values, values[1:]) if left != right]
    if len(mids) <= 32:
        return mids
    return [mids[round(index * (len(mids) - 1) / 31)] for index in range(32)]


def partition_samples(
    samples: Sequence[BehaviorSample],
    feature: str,
    threshold: float,
    missing_side: str,
) -> tuple[list[BehaviorSample], list[BehaviorSample]]:
    left: list[BehaviorSample] = []
    right: list[BehaviorSample] = []
    for sample in samples:
        value = feature_value(sample.state, feature)
        if value is None:
            (left if missing_side == "left" else right).append(sample)
        elif value <= threshold:
            left.append(sample)
        else:
            right.append(sample)
    return left, right


def feature_value(state: JsonObject, feature: str) -> float | None:
    value = state.get(feature)
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return None


def weighted_gini(left: Sequence[BehaviorSample], right: Sequence[BehaviorSample]) -> float:
    total = len(left) + len(right)
    return (len(left) / total) * gini(left) + (len(right) / total) * gini(right)


def gini(samples: Sequence[BehaviorSample]) -> float:
    if not samples:
        return 0.0
    total = len(samples)
    return 1.0 - sum((count / total) ** 2 for count in Counter(sample.action for sample in samples).values())


def action_distribution(samples: Sequence[BehaviorSample]) -> Counter[str]:
    return Counter(sample.action for sample in samples)


def leaf_node(distribution: Counter[str]) -> TreeNode:
    sample_count = sum(distribution.values())
    action, count = max(distribution.items(), key=lambda item: (item[1], item[0]))
    confidence = count / sample_count if sample_count else 0.0
    return {
        "type": "leaf",
        "action": action,
        "confidence": round(confidence, 6),
        "sampleCount": sample_count,
        "distribution": dict(sorted(distribution.items())),
    }


def evaluate_tree(root: TreeNode | None, samples: Sequence[BehaviorSample]) -> JsonObject:
    if root is None or not samples:
        return {
            "sampleCount": len(samples),
            "matchCount": 0,
            "actionMatchRate": None,
            "averageConfidence": None,
            "byAction": {},
        }

    match_count = 0
    confidence_total = 0.0
    by_action: dict[str, Counter[str]] = {action: Counter() for action in ACTION_TYPES}
    for sample in samples:
        predicted_action, confidence = predict(root, sample.state)
        confidence_total += confidence
        if predicted_action == sample.action:
            match_count += 1
            by_action[sample.action]["match"] += 1
        else:
            by_action[sample.action]["mismatch"] += 1
        by_action[sample.action]["total"] += 1

    return {
        "sampleCount": len(samples),
        "matchCount": match_count,
        "actionMatchRate": round(match_count / len(samples), 6),
        "averageConfidence": round(confidence_total / len(samples), 6),
        "byAction": {
            action: {
                "sampleCount": counts["total"],
                "matchCount": counts["match"],
                "mismatchCount": counts["mismatch"],
                "matchRate": round(counts["match"] / counts["total"], 6) if counts["total"] else None,
            }
            for action, counts in by_action.items()
            if counts["total"]
        },
    }


def predict(node: TreeNode, state: JsonObject) -> tuple[str, float]:
    current = node
    while current.get("type") == "branch":
        value = feature_value(state, str(current["feature"]))
        if value is None:
            current = current[current.get("missing", "left")]
        else:
            current = current["left"] if value <= float(current["threshold"]) else current["right"]
    return str(current["action"]), float(current.get("confidence", 0))


def assign_split(sample_id: str, split_seed: str, eval_ratio_value: float) -> str:
    digest = hashlib.sha256(f"{split_seed}:{sample_id}".encode("utf-8")).hexdigest()
    bucket = int(digest[:12], 16) / float(0xFFFFFFFFFFFF)
    return "eval" if bucket < eval_ratio_value else "train"


def split_samples(
    samples: Sequence[BehaviorSample],
    split_seed: str,
    eval_ratio_value: float,
) -> tuple[list[BehaviorSample], list[BehaviorSample]]:
    train: list[BehaviorSample] = []
    eval_samples: list[BehaviorSample] = []
    for sample in samples:
        if assign_split(sample.sample_id, split_seed, eval_ratio_value) == "eval":
            eval_samples.append(sample)
        else:
            train.append(sample)

    if not train and eval_samples:
        train, eval_samples = eval_samples, []
    return train, eval_samples


def build_model(
    run_id: str,
    root: TreeNode | None,
    train_samples: Sequence[BehaviorSample],
    eval_samples: Sequence[BehaviorSample],
    eval_report: JsonObject,
    min_confidence: float,
) -> JsonObject:
    return {
        "type": MODEL_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "policyId": f"worker-task-bc.{run_id}.v1",
        "source": "runtime-summary behavior.workerTaskPolicy heuristic traces",
        "liveEffect": False,
        "minConfidence": min_confidence,
        "actionTypes": list(ACTION_TYPES),
        "features": list(FEATURES),
        "root": root,
        "metadata": {
            "trainingSampleCount": len(train_samples),
            "evaluationSampleCount": len(eval_samples),
            "evaluationMatchRate": eval_report.get("actionMatchRate"),
            "notes": "Shadow-only BC artifact; runtime integration keeps heuristic fallback and liveEffect=false.",
        },
    }


def build_report(
    run_id: str,
    samples: Sequence[BehaviorSample],
    train_samples: Sequence[BehaviorSample],
    eval_samples: Sequence[BehaviorSample],
    train_report: JsonObject,
    eval_report: JsonObject,
    max_depth: int,
    min_samples_split: int,
) -> JsonObject:
    return {
        "type": REPORT_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "runId": run_id,
        "liveEffect": False,
        "method": "stdlib-decision-tree-behavioral-cloning",
        "features": list(FEATURES),
        "sampleCount": len(samples),
        "train": train_report,
        "eval": eval_report,
        "acceptance": {
            "targetActionMatchRate": 0.9,
            "actionMatchRate": eval_report.get("actionMatchRate") if eval_samples else train_report.get("actionMatchRate"),
            "passesFidelityGate": bool(
                (eval_report.get("actionMatchRate") if eval_samples else train_report.get("actionMatchRate")) is not None
                and (eval_report.get("actionMatchRate") if eval_samples else train_report.get("actionMatchRate")) >= 0.9
            ),
            "simulatorStable": None,
            "simulatorNotes": "Not evaluated by this offline trainer; consume this artifact in the simulator lane.",
        },
        "hyperparameters": {
            "maxDepth": max_depth,
            "minSamplesSplit": min_samples_split,
        },
        "actionCounts": dict(sorted(Counter(sample.action for sample in samples).items())),
    }


def build_run_id(samples: Sequence[BehaviorSample], max_depth: int, eval_ratio_value: float, split_seed: str) -> str:
    seed = {
        "schemaVersion": SCHEMA_VERSION,
        "sampleIds": [sample.sample_id for sample in samples],
        "actions": [sample.action for sample in samples],
        "features": list(FEATURES),
        "maxDepth": max_depth,
        "evalRatio": eval_ratio_value,
        "splitSeed": split_seed,
    }
    return f"worker-bc-{canonical_hash(seed)[:12]}"


def validate_run_id(run_id: str) -> None:
    if not run_id or run_id in {".", ".."} or any(char not in RUN_ID_CHARS for char in run_id):
        raise ValueError("run id may contain only letters, numbers, dot, underscore, and hyphen")


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n", encoding="utf-8")


def write_text(path: Path, value: str) -> None:
    path.write_text(value, encoding="utf-8")


def render_ts_model(model: JsonObject) -> str:
    return "\n".join(
        [
            "import type { WorkerTaskBcModel } from './workerTaskPolicy';",
            "",
            f"export const WORKER_TASK_BC_MODEL: WorkerTaskBcModel = {json.dumps(model, indent=2, sort_keys=True)};",
            "",
        ]
    )


def train_policy(
    paths: Sequence[str],
    out_dir: Path,
    run_id: str | None = None,
    sample_limit: int = DEFAULT_SAMPLE_LIMIT,
    eval_ratio_value: float = DEFAULT_EVAL_RATIO,
    split_seed: str = "screeps-worker-bc-v1",
    max_depth: int = DEFAULT_MAX_DEPTH,
    min_samples_split: int = DEFAULT_MIN_SAMPLES_SPLIT,
    min_confidence: float = DEFAULT_MIN_CONFIDENCE,
    ts_out: Path | None = None,
) -> JsonObject:
    samples = extract_behavior_samples(paths, sample_limit=sample_limit)
    resolved_run_id = run_id or build_run_id(samples, max_depth, eval_ratio_value, split_seed)
    validate_run_id(resolved_run_id)
    train_samples, eval_samples = split_samples(samples, split_seed, eval_ratio_value)
    root = train_decision_tree(train_samples, max_depth=max_depth, min_samples_split=min_samples_split)
    train_report = evaluate_tree(root, train_samples)
    eval_report = evaluate_tree(root, eval_samples)
    model = build_model(resolved_run_id, root, train_samples, eval_samples, eval_report, min_confidence)
    report = build_report(
        resolved_run_id,
        samples,
        train_samples,
        eval_samples,
        train_report,
        eval_report,
        max_depth,
        min_samples_split,
    )

    run_dir = out_dir.expanduser() / resolved_run_id
    out_dir.expanduser().mkdir(parents=True, exist_ok=True)
    staging_dir = Path(tempfile.mkdtemp(prefix=f".{resolved_run_id}.", suffix=".staging", dir=str(out_dir.expanduser())))
    try:
        write_json(staging_dir / "worker_task_policy.json", model)
        write_json(staging_dir / "evaluation_report.json", report)
        if ts_out is not None:
            write_text(staging_dir / "workerTaskBcModel.ts", render_ts_model(model))
        run_dir.mkdir(parents=True, exist_ok=True)
        os.replace(staging_dir / "worker_task_policy.json", run_dir / "worker_task_policy.json")
        os.replace(staging_dir / "evaluation_report.json", run_dir / "evaluation_report.json")
        if ts_out is not None:
            ts_out.parent.mkdir(parents=True, exist_ok=True)
            os.replace(staging_dir / "workerTaskBcModel.ts", ts_out)
    finally:
        shutil.rmtree(staging_dir, ignore_errors=True)

    return {
        "ok": True,
        "type": "worker-task-bc-training-run",
        "schemaVersion": SCHEMA_VERSION,
        "runId": resolved_run_id,
        "outDir": dataset_export.display_path(run_dir),
        "sampleCount": len(samples),
        "trainSampleCount": len(train_samples),
        "evalSampleCount": len(eval_samples),
        "actionMatchRate": report["acceptance"]["actionMatchRate"],
        "passesFidelityGate": report["acceptance"]["passesFidelityGate"],
        "liveEffect": False,
        "files": {
            "model": "worker_task_policy.json",
            "evaluationReport": "evaluation_report.json",
            **({"tsModel": dataset_export.display_path(ts_out)} if ts_out is not None else {}),
        },
    }


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train a shadow worker task behavioral cloning policy from runtime-summary behavior samples."
    )
    parser.add_argument("paths", nargs="*", help="runtime artifact files or directories to scan")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--run-id")
    parser.add_argument("--sample-limit", type=positive_int, default=DEFAULT_SAMPLE_LIMIT)
    parser.add_argument("--eval-ratio", type=ratio, default=DEFAULT_EVAL_RATIO)
    parser.add_argument("--split-seed", default="screeps-worker-bc-v1")
    parser.add_argument("--max-depth", type=positive_int, default=DEFAULT_MAX_DEPTH)
    parser.add_argument("--min-samples-split", type=positive_int, default=DEFAULT_MIN_SAMPLES_SPLIT)
    parser.add_argument("--min-confidence", type=probability, default=DEFAULT_MIN_CONFIDENCE)
    parser.add_argument("--ts-out", type=Path, help="optional generated TypeScript model export path")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    args.out_dir.expanduser().mkdir(parents=True, exist_ok=True)
    summary = train_policy(
        paths=args.paths,
        out_dir=args.out_dir,
        run_id=args.run_id,
        sample_limit=args.sample_limit,
        eval_ratio_value=args.eval_ratio,
        split_seed=args.split_seed,
        max_depth=args.max_depth,
        min_samples_split=args.min_samples_split,
        min_confidence=args.min_confidence,
        ts_out=args.ts_out,
    )
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
