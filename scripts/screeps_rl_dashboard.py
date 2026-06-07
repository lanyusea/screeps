#!/usr/bin/env python3
"""Generate a fail-safe single-page RL progress dashboard."""

from __future__ import annotations

import argparse
import html
import json
import math
import os
import re
import tempfile
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

import rl_conclusion_registry
import screeps_rl_experiment_card as experiment_card


JsonObject = dict[str, Any]

DEFAULT_OUTPUT = Path("runtime-artifacts/rl-dashboard.html")
CONCLUSION_STATUSES = ("OPEN", "STALE", "ACTIONED", "VALIDATING", "CLOSED")
LANES = (
    ("E1", "shadow-eval"),
    ("E2", "simulator"),
    ("E3", "strategy comparison"),
    ("E4", "training"),
    ("E5", "rollout"),
)
SECRET_PATH_MARKERS = ("token", "secret", "password", "steam_key", ".screepsrc")
SAFETY_FALSE_FIELDS = ("liveEffect", "officialMmoWrites", "officialMmoWritesAllowed")
SAFETY_TRUE_FIELDS = ("conservative_actions_only", "ood_rejection")
REWARD_COMPONENT_ORDER = ("reliability", "territory", "resources", "kills")
LOOP_A_CARD_SUPPLY_TYPE = "screeps-rl-loop-a-card-supply"
LOOP_A_CARD_SUPPLY_CONSUMER = "loop-a-policy-gradient"
LOOP_A_CARD_SUPPLY_STATES = ("available", "consumed")
STANDALONE_CARD_SUPPLY_SOURCE = "standalone_experiment_card"
TENCENT_CARD_IDENTITY_FIELDS = ("runId", "cardId", "datasetRunId")
TENCENT_CARD_SUPPLY_SOURCES = (
    "tencent_controller_summary",
    "tencent_internal_experiment_card",
    "tencent_internal_training_report",
)
TENCENT_CARD_IDENTITY_KEYS = {
    "batchrunid": "runId",
    "runid": "runId",
    "tencentbatchrunid": "runId",
    "tencentrunid": "runId",
    "cardid": "cardId",
    "experimentcardid": "cardId",
    "tencentcardid": "cardId",
    "datasetrunid": "datasetRunId",
    "tencentdatasetrunid": "datasetRunId",
}
CARD_SUPPLY_BLOCKER_MARKERS = (
    "loopacardpathstalledcycles",
    "loopacardpipelinestalled",
    "cardpipelinestalled",
    "nostandaloneexperimentcard",
    "nounconsumedexperimentcard",
    "standaloneexperimentcard",
    "standalonecardsupply",
    "cardsupplystarvation",
)
CARD_SUPPLY_BLOCKER_FIELD_MARKERS = (
    "loopacardpathstalledcycles",
    "loopacardpipelinestalled",
    "cardpipelinestalled",
    "nostandaloneexperimentcard",
    "nounconsumedexperimentcard",
    "standalonecardsupply",
    "cardsupplystarvation",
)
CARD_SUPPLY_BLOCKER_TEXT_FIELDS = (
    "trainingBlocker",
    "nextTrainingCapabilityAction",
    "blocker",
    "activeBlocker",
    "cardSupplyBlocker",
    "requiredAction",
    "nextAction",
)
CARD_SUPPLY_BLOCKER_OBJECT_FIELDS = ("evidenceWindows",)
INACTIVE_CARD_SUPPLY_BLOCKER_VALUES = (
    "",
    "0",
    "false",
    "inactive",
    "na",
    "none",
    "null",
    "resolved",
)
TIMESTAMP_KEYS = (
    "createdAt",
    "producedAt",
    "updatedAt",
    "timestamp",
    "gateCreatedAt",
    "lastNewRunAt",
    "lastSeenAt",
)
FILENAME_TIMESTAMP_RE = re.compile(r"(\d{8}T\d{4,6}Z)")
GATE_ID_TIMESTAMP_RE = re.compile(r"gate-(\d{8}T\d{6}Z)")
PREFLIGHT_FINAL_STATUS_KEYS = {
    "preflight",
    "preflightok",
    "preflightonly",
    "preflightpassed",
    "preflightvalidated",
}
CONTROLLER_COMPUTE_FINAL_STATUS_KEYS = {"running", "completed", "success", "ok"}
TRAINING_COMPUTE_CLAIM_STATUS_KEYS = {
    "run",
    "running",
    "runwithanomaly",
    "completed",
    "success",
    "ok",
    "traininginflight",
    "computeready",
}
POLICY_COMPUTE_CLAIM_STATUS_KEYS = {
    "advantage",
    "approved",
    "computeready",
    "pass",
    "promotable",
    "proven",
    "rolloutapproved",
    "validated",
}
POLICY_ADVANTAGE_METRIC_STATUS_KEYS = {
    "advantage",
    "better",
    "promotable",
    "proven",
    "validated",
    "win",
}
POLICY_TRAINING_IDENTITY_KEYS = {
    "report": {
        "reportid",
        "trainingreport",
        "trainingreportid",
        "trainingreportids",
        "trainingreportpath",
        "trainingreportpaths",
        "trainingreports",
    },
    "run": {
        "batchrunid",
        "runid",
        "tencentbatchrunid",
        "tencentrunid",
        "trainingrunid",
    },
    "instance": {
        "controllerinstanceid",
        "instanceid",
    },
}
STRONG_TRAINING_REPORT_KEYS = {
    "trainingreport",
    "trainingreportid",
    "trainingreportids",
    "trainingreportpath",
    "trainingreportpaths",
    "trainingreports",
}
ENVIRONMENT_RUN_COUNT_KEYS = {
    "completedenvironmentruns",
    "completedenvironments",
    "environmentruns",
    "environmentscompleted",
    "environmentsrun",
}
WEAK_COMPUTE_COUNT_KEYS = {
    "artifactcount",
    "episodesrun",
    "policyupdateiterations",
    "simulatorticksrun",
}


@dataclass(frozen=True)
class LoadedArtifact:
    path: Path
    payload: JsonObject
    timestamp: datetime


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=True, default=str)


def repo_root_from_script() -> Path:
    return Path(__file__).resolve().parents[1]


def parse_iso_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def timestamp_from_filename(path: Path) -> datetime | None:
    match = FILENAME_TIMESTAMP_RE.search(path.name)
    if not match:
        return None
    raw = match.group(1)
    compact = raw.replace("T", "").replace("Z", "")
    for fmt in ("%Y%m%d%H%M%S", "%Y%m%d%H%M"):
        try:
            return datetime.strptime(compact, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def timestamp_from_gate_id(payload: JsonObject) -> datetime | None:
    gate_id = first_text(payload, (("gateId",), ("gate_id",), ("e1Gate", "gateId")))
    if gate_id is None:
        return None
    match = GATE_ID_TIMESTAMP_RE.search(gate_id)
    if match is None:
        return None
    try:
        return datetime.strptime(match.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def artifact_timestamp(path: Path, payload: JsonObject) -> datetime:
    for key in TIMESTAMP_KEYS:
        parsed = parse_iso_datetime(payload.get(key))
        if parsed is not None:
            return parsed

    parsed = timestamp_from_filename(path)
    if parsed is not None:
        return parsed

    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    except OSError:
        return datetime.fromtimestamp(0, tz=timezone.utc)


def display_timestamp(value: datetime | str | None) -> str:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    parsed = parse_iso_datetime(value)
    if parsed is not None:
        return display_timestamp(parsed)
    return text_value(value) or "N/A"


def safe_display_path(path: Path | str | None, repo_root: Path) -> str:
    if path is None:
        return "N/A"
    text = str(path)
    if any(marker in text.lower() for marker in SECRET_PATH_MARKERS):
        return "[redacted-path]"
    try:
        resolved = Path(path).expanduser().resolve()
        return str(resolved.relative_to(repo_root.resolve()))
    except (OSError, ValueError):
        return text


def load_json(path: Path, warnings: list[str], repo_root: Path) -> JsonObject | None:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        warnings.append(f"Could not read {safe_display_path(path, repo_root)}: {error}")
        return None
    except json.JSONDecodeError as error:
        warnings.append(f"Invalid JSON in {safe_display_path(path, repo_root)}: {error}")
        return None
    if not isinstance(parsed, dict):
        warnings.append(f"Ignored non-object JSON in {safe_display_path(path, repo_root)}")
        return None
    return parsed


def load_artifact(path: Path, warnings: list[str], repo_root: Path) -> LoadedArtifact | None:
    payload = load_json(path, warnings, repo_root)
    if payload is None:
        return None
    return LoadedArtifact(path=path, payload=payload, timestamp=artifact_timestamp(path, payload))


def load_optional_artifact(path: Path, warnings: list[str], repo_root: Path) -> LoadedArtifact | None:
    if not path.exists():
        return None
    return load_artifact(path, warnings, repo_root)


def unique_paths(paths: Iterable[Path]) -> list[Path]:
    seen: set[Path] = set()
    unique: list[Path] = []
    for path in paths:
        try:
            resolved = path.resolve()
        except OSError:
            resolved = path
        if resolved in seen:
            continue
        seen.add(resolved)
        unique.append(path)
    return unique


def existing_globs(root: Path, patterns: Sequence[str]) -> list[Path]:
    if not root.exists():
        return []
    paths: list[Path] = []
    for pattern in patterns:
        paths.extend(path for path in root.glob(pattern) if path.is_file())
    return unique_paths(paths)


def latest_artifact(
    root: Path,
    patterns: Sequence[str],
    *,
    warnings: list[str],
    repo_root: Path,
    predicate: Any | None = None,
) -> LoadedArtifact | None:
    artifacts: list[LoadedArtifact] = []
    for path in existing_globs(root, patterns):
        artifact = load_artifact(path, warnings, repo_root)
        if artifact is None:
            continue
        if predicate is not None and not predicate(artifact.path, artifact.payload):
            continue
        artifacts.append(artifact)
    if not artifacts:
        return None
    return max(artifacts, key=lambda item: item.timestamp)


def normalized_key(value: str) -> str:
    return "".join(character for character in value.lower() if character.isalnum())


def number_value(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        parsed = float(value)
    elif isinstance(value, str):
        try:
            parsed = float(value)
        except ValueError:
            return None
    else:
        return None
    if not math.isfinite(parsed):
        return None
    return parsed


def int_value(value: Any) -> int | None:
    parsed = number_value(value)
    if parsed is None:
        return None
    return int(parsed)


def text_value(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def as_dict(value: Any) -> JsonObject:
    return value if isinstance(value, dict) else {}


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def first_present(value: JsonObject, keys: Sequence[str]) -> Any:
    for key in keys:
        if key in value:
            return value[key]
    return None


def policy_update_evidence_value(payload: JsonObject, policy_update: JsonObject, key: str) -> Any:
    value = payload.get(key)
    if value is not None and value != {}:
        return value
    return policy_update.get(key)


def iter_json_objects(value: Any) -> Iterable[JsonObject]:
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from iter_json_objects(item)
    elif isinstance(value, list):
        for item in value:
            yield from iter_json_objects(item)


def value_has_reference(value: Any) -> bool:
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return False
        try:
            parsed = float(text)
        except ValueError:
            return True
        return math.isfinite(parsed) and parsed > 0
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value > 0
    if isinstance(value, dict):
        return any(value_has_reference(item) for item in value.values())
    if isinstance(value, list):
        return any(value_has_reference(item) for item in value)
    return False


def positive_count(value: Any) -> int | None:
    parsed = int_value(value)
    if parsed is None or parsed <= 0:
        return None
    return parsed


def status_key(value: Any) -> str:
    raw = text_value(value)
    return normalized_key(raw) if raw is not None else ""


def controller_summary_final_status_key(node: JsonObject) -> str:
    return status_key(first_present(node, ("finalStatus", "final_status")))


def node_looks_like_controller_summary(node: JsonObject) -> bool:
    if node.get("type") == "screeps-tencent-batch-rl-run":
        return True
    return any(key in node for key in ("finalStatus", "final_status")) and any(
        key in node
        for key in (
            "instanceId",
            "instance_id",
            "workerUser",
            "worker_user",
            "environmentsRun",
            "environmentExecution",
            "environment_execution",
            "outputs",
        )
    )


def preflight_marker_present(payload: JsonObject) -> bool:
    return any(
        node_looks_like_controller_summary(node)
        and controller_summary_final_status_key(node) in PREFLIGHT_FINAL_STATUS_KEYS
        for node in iter_json_objects(payload)
    )


def non_blank_text_value(value: Any) -> str | None:
    text = text_value(value)
    if text is None:
        return None
    stripped = text.strip()
    return stripped or None


def collect_strong_compute_evidence(payload: JsonObject) -> list[JsonObject]:
    signals: list[JsonObject] = []
    seen: set[tuple[str, str]] = set()

    def add(field: str, value: Any) -> None:
        key = (field, str(value))
        if key in seen:
            return
        seen.add(key)
        signals.append({"field": field, "value": value})

    for node in iter_json_objects(payload):
        for key, raw in node.items():
            normalized = normalized_key(str(key))
            if normalized in STRONG_TRAINING_REPORT_KEYS and value_has_reference(raw):
                add(str(key), "present")
            if normalized in ENVIRONMENT_RUN_COUNT_KEYS:
                count = positive_count(raw)
                if count is not None:
                    add(str(key), count)
            if normalized == "environmentexecution":
                execution = as_dict(raw)
                completed = (
                    positive_count(execution.get("completed"))
                    or positive_count(execution.get("Completed"))
                    or positive_count(execution.get("completedCount"))
                )
                if completed is not None:
                    add("environmentExecution.completed", completed)

        if not node_looks_like_controller_summary(node):
            continue
        final_status = controller_summary_final_status_key(node)
        if final_status in PREFLIGHT_FINAL_STATUS_KEYS:
            continue
        instance_id = non_blank_text_value(first_present(node, ("instanceId", "instance_id")))
        worker_user = non_blank_text_value(first_present(node, ("workerUser", "worker_user")))
        has_compute_status = final_status in CONTROLLER_COMPUTE_FINAL_STATUS_KEYS
        if instance_id is not None and has_compute_status:
            add("controllerSummary.instanceId", "present")
        elif worker_user is not None and has_compute_status:
            add("controllerSummary.workerUser", "present")

    return signals


def collect_weak_compute_evidence(payload: JsonObject) -> list[JsonObject]:
    signals: list[JsonObject] = []
    seen: set[tuple[str, str]] = set()

    def add(field: str, value: Any) -> None:
        key = (field, str(value))
        if key in seen:
            return
        seen.add(key)
        signals.append({"field": field, "value": value})

    for node in iter_json_objects(payload):
        for key, raw in node.items():
            normalized = normalized_key(str(key))
            if normalized in WEAK_COMPUTE_COUNT_KEYS:
                count = positive_count(raw)
                if count is not None:
                    add(str(key), count)
    return signals


def compute_evidence_summary(payload: JsonObject) -> JsonObject:
    strong_signals = collect_strong_compute_evidence(payload)
    preflight_only = preflight_marker_present(payload) and not strong_signals
    weak_signals = [] if preflight_only else collect_weak_compute_evidence(payload)
    signals = strong_signals + weak_signals
    if strong_signals:
        classification = "COMPUTE_CONFIRMED"
        blocker = None
    elif preflight_only:
        classification = "PREFLIGHT_ONLY_VALIDATION"
        blocker = (
            "Preflight-only controller validation found; no training report, environment completion, "
            "or provisioned compute evidence is present."
        )
    else:
        classification = "MISSING_COMPUTE_EVIDENCE"
        blocker = (
            "No real compute evidence found; require training report IDs, completed environments, "
            "or controller execution/provisioning beyond preflight."
        )
    return {
        "hasCompute": bool(strong_signals),
        "classification": classification,
        "signals": signals[:12],
        "blocker": blocker,
    }


def strong_compute_evidence_summary(payload: JsonObject) -> JsonObject:
    signals = collect_strong_compute_evidence(payload)
    if signals:
        return {
            "hasCompute": True,
            "classification": "COMPUTE_CONFIRMED",
            "signals": signals[:12],
            "blocker": None,
        }
    if preflight_marker_present(payload):
        return {
            "hasCompute": False,
            "classification": "PREFLIGHT_ONLY_VALIDATION",
            "signals": [],
            "blocker": (
                "Preflight-only controller validation found; no training report, environment completion, "
                "or provisioned compute evidence is present."
            ),
        }
    return {
        "hasCompute": False,
        "classification": "MISSING_COMPUTE_EVIDENCE",
        "signals": [],
        "blocker": (
            "No real compute evidence found; require training report IDs, completed environments, "
            "or controller execution/provisioning beyond preflight."
        ),
    }


def compute_evidence_summary_has_strong_signal(summary: JsonObject) -> bool:
    for signal in as_list(summary.get("signals")):
        field = text_value(as_dict(signal).get("field"))
        if field is None:
            continue
        if field in {
            "environmentExecution.completed",
            "controllerSummary.instanceId",
            "controllerSummary.workerUser",
        }:
            return True
        normalized = normalized_key(field)
        if normalized in STRONG_TRAINING_REPORT_KEYS or normalized in ENVIRONMENT_RUN_COUNT_KEYS:
            return True
    return False


def identity_text_values(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            yield stripped
    elif isinstance(value, list):
        for item in value:
            yield from identity_text_values(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from identity_text_values(item)


def collect_policy_training_identities(payload: JsonObject) -> JsonObject:
    identities: dict[str, list[str]] = {}
    seen: set[tuple[str, str]] = set()
    for node in iter_json_objects(payload):
        for key, raw in node.items():
            normalized = normalized_key(str(key))
            for kind, identity_keys in POLICY_TRAINING_IDENTITY_KEYS.items():
                if normalized not in identity_keys:
                    continue
                for value in identity_text_values(raw):
                    seen_key = (kind, value)
                    if seen_key in seen:
                        continue
                    seen.add(seen_key)
                    identities.setdefault(kind, []).append(value)
    return identities


def policy_training_identity_match(payload: JsonObject, training: JsonObject | None) -> JsonObject | None:
    policy_identities = collect_policy_training_identities(payload)
    training_identities = as_dict((training or {}).get("identity"))
    for kind, policy_values in policy_identities.items():
        training_values = {
            value
            for value in as_list(training_identities.get(kind))
            if isinstance(value, str) and value
        }
        for value in policy_values:
            if value in training_values:
                return {"kind": kind, "value": value}
    return None


def card_training_approach(card: JsonObject) -> str | None:
    return text_value(first_present(card, ("training_approach", "trainingApproach")))


def card_supply_metadata(card: JsonObject) -> JsonObject:
    return as_dict(first_present(card, ("card_supply", "cardSupply")))


def safety_flags_are_shadow(raw: JsonObject) -> bool:
    safety = as_dict(raw.get("safety"))
    if not safety:
        return False
    for field in SAFETY_FALSE_FIELDS:
        if safety.get(field) is not False:
            return False
        if field in raw and raw[field] is not False:
            return False
    for field in SAFETY_TRUE_FIELDS:
        if safety.get(field) is not True:
            return False
        if field in raw and raw[field] is not True:
            return False
    return True


def reward_model_is_lexicographic(raw: JsonObject) -> bool:
    reward = as_dict(first_present(raw, ("reward_model", "rewardModel")))
    if not reward:
        return False
    if reward.get("type") != "lexicographic":
        return False
    order = first_present(reward, ("component_order", "componentOrder"))
    if order != list(REWARD_COMPONENT_ORDER):
        return False
    scalar_authorized = first_present(
        reward,
        ("scalar_weighted_sum_authorized", "scalarWeightedSumAuthorized"),
    )
    return scalar_authorized is False


def valid_loop_a_card_supply(card: JsonObject) -> bool:
    supply = card_supply_metadata(card)
    if not supply:
        return False
    if supply.get("type") != LOOP_A_CARD_SUPPLY_TYPE:
        return False
    if supply.get("consumer") != LOOP_A_CARD_SUPPLY_CONSUMER:
        return False
    if supply.get("state") not in LOOP_A_CARD_SUPPLY_STATES:
        return False
    if supply.get("training_approach") != card_training_approach(card):
        return False
    if supply.get("safety_status") != "shadow" or supply.get("status_field") != "status":
        return False
    state = supply.get("state")
    if state == "available":
        return (
            card.get("status") == "shadow"
            and card_training_approach(card) == "policy_gradient"
            and supply.get("available_for_training") is True
            and supply.get("consumed_at") is None
            and supply.get("consumed_by_report_id") is None
        )
    return (
        supply.get("available_for_training") is False
        and isinstance(supply.get("consumed_at"), str)
        and isinstance(supply.get("consumed_by_report_id"), str)
        and bool(supply.get("consumed_by_report_id"))
    )


def policy_gradient_metadata_present(card: JsonObject) -> bool:
    return isinstance(first_present(card, ("policy_gradient", "policyGradient")), dict)


def valid_policy_gradient_card(card: JsonObject, *, reward_container: JsonObject | None = None) -> bool:
    if card.get("status") != "shadow":
        return False
    if card_training_approach(card) != "policy_gradient":
        return False
    if not safety_flags_are_shadow(card):
        return False
    if not policy_gradient_metadata_present(card):
        return False
    return reward_model_is_lexicographic(card) or (
        reward_container is not None and reward_model_is_lexicographic(reward_container)
    )


def loop_a_card_supply_summary(
    *,
    card: JsonObject,
    path: Path | None,
    source: str,
    run_id: str | None = None,
) -> JsonObject:
    supply = card_supply_metadata(card)
    has_supply = valid_loop_a_card_supply(card)
    summary: JsonObject = {
        "status": "PRIMARY_SATISFIED",
        "classification": "TENCENT_INTERNAL_POLICY_GRADIENT_PRIMARY",
        "source": source,
        "severity": "OK",
        "fallbackStatus": "DEGRADED",
        "fallbackSeverity": "P2",
        "fallbackReason": "Standalone experiment-card availability is a local fallback path; Tencent internal policy-gradient card evidence satisfies primary training supply.",
        "cardId": first_present(card, ("card_id", "cardId")),
        "createdAt": first_present(card, ("created_at", "createdAt")),
        "datasetRunId": first_present(card, ("dataset_run_id", "datasetRunId")),
        "trainingApproach": card_training_approach(card),
        "path": str(path) if path is not None else None,
        "runId": run_id,
        "hasLoopACardSupplyMetadata": has_supply,
    }
    if supply:
        summary["cardSupply"] = supply
    if not has_supply:
        summary["metadataNote"] = (
            "Valid legacy Tencent internal policy-gradient card evidence has no explicit Loop A card_supply "
            "metadata; generated Tencent cards should include it going forward."
        )
    return summary


def standalone_card_supply_summary(*, card: JsonObject, path: Path) -> JsonObject:
    supply = card_supply_metadata(card)
    return {
        "status": "PRIMARY_SATISFIED",
        "classification": "STANDALONE_POLICY_GRADIENT_FALLBACK_AVAILABLE",
        "source": STANDALONE_CARD_SUPPLY_SOURCE,
        "severity": "OK",
        "fallbackStatus": "AVAILABLE",
        "fallbackSeverity": "OK",
        "fallbackReason": "A safety-validated standalone Loop A policy-gradient fallback card is available.",
        "cardId": first_present(card, ("card_id", "cardId")),
        "createdAt": first_present(card, ("created_at", "createdAt")),
        "datasetRunId": first_present(card, ("dataset_run_id", "datasetRunId")),
        "trainingApproach": card_training_approach(card),
        "path": str(path),
        "runId": None,
        "hasLoopACardSupplyMetadata": True,
        "cardSupply": supply,
    }


def blocked_card_supply_summary(reason: str | None = None) -> JsonObject:
    return {
        "status": "BLOCKED",
        "classification": "CARD_SUPPLY_BLOCKED",
        "source": None,
        "severity": "P0",
        "reason": reason or "No valid standalone or Tencent internal policy-gradient card supply evidence.",
    }


def tencent_summary_run_id(payload: JsonObject, path: Path) -> str:
    return text_value(payload.get("runId")) or path.parent.name


def standalone_card_supply_from_card(
    path: Path,
    warnings: list[str],
    repo_root: Path,
    *,
    consumed_card_ids: set[str],
) -> JsonObject | None:
    artifact = load_artifact(path, warnings, repo_root)
    if artifact is None:
        return None
    if not experiment_card.is_loop_a_card_available_for_training(artifact.payload, consumed_card_ids):
        return None
    return standalone_card_supply_summary(card=artifact.payload, path=artifact.path)


def discover_standalone_card_supply_candidates(
    artifact_root: Path,
    *,
    warnings: list[str],
    repo_root: Path,
) -> list[JsonObject]:
    card_dir = artifact_root / "rl-experiment-cards"
    consumed_card_ids = experiment_card.consumed_card_ids_from_training_reports(artifact_root / "rl-training")
    candidates = [
        evidence
        for path in existing_globs(card_dir, ("*.json",))
        if (
            evidence := standalone_card_supply_from_card(
                path,
                warnings,
                repo_root,
                consumed_card_ids=consumed_card_ids,
            )
        )
        is not None
    ]
    return sorted(candidates, key=card_supply_candidate_key, reverse=True)


def card_supply_from_full_card(path: Path, warnings: list[str], repo_root: Path, *, run_id: str) -> JsonObject | None:
    artifact = load_artifact(path, warnings, repo_root)
    if artifact is None:
        return None
    if not valid_policy_gradient_card(artifact.payload):
        return None
    return loop_a_card_supply_summary(
        card=artifact.payload,
        path=artifact.path,
        source="tencent_internal_experiment_card",
        run_id=run_id,
    )


def card_supply_from_training_report(path: Path, warnings: list[str], repo_root: Path, *, run_id: str) -> JsonObject | None:
    artifact = load_artifact(path, warnings, repo_root)
    if artifact is None:
        return None
    payload = artifact.payload
    if not safety_flags_are_shadow(payload):
        return None
    card = as_dict(payload.get("experimentCard"))
    if not valid_policy_gradient_card(card, reward_container=payload):
        return None
    return loop_a_card_supply_summary(
        card=card,
        path=artifact.path,
        source="tencent_internal_training_report",
        run_id=run_id,
    )


def card_supply_candidates_from_tencent_run_dir(
    run_dir: Path,
    warnings: list[str],
    repo_root: Path,
    *,
    run_id: str,
    summary_artifact: LoadedArtifact | None = None,
) -> list[JsonObject]:
    candidates: list[JsonObject] = []

    if summary_artifact is not None:
        output_card = as_dict(as_dict(summary_artifact.payload.get("outputs")).get("experimentCard"))
        if valid_policy_gradient_card(output_card):
            candidates.append(
                loop_a_card_supply_summary(
                    card=output_card,
                    path=summary_artifact.path,
                    source="tencent_controller_summary",
                    run_id=run_id,
                )
            )

    full_card = run_dir / "experiment_card.json"
    if full_card.is_file():
        evidence = card_supply_from_full_card(full_card, warnings, repo_root, run_id=run_id)
        if evidence is not None:
            candidates.append(evidence)

    report_dir = run_dir / "remote" / "runtime-artifacts" / "rl-training"
    if report_dir.is_dir():
        for report in sorted(report_dir.glob("*.json")):
            evidence = card_supply_from_training_report(report, warnings, repo_root, run_id=run_id)
            if evidence is not None:
                candidates.append(evidence)

    return candidates


def card_supply_candidates_from_controller_summary(
    artifact: LoadedArtifact,
    warnings: list[str],
    repo_root: Path,
) -> list[JsonObject]:
    payload = artifact.payload
    if payload.get("type") != "screeps-tencent-batch-rl-run" and "tencent-cloud" not in str(artifact.path):
        return []
    run_id = tencent_summary_run_id(payload, artifact.path)
    return card_supply_candidates_from_tencent_run_dir(
        artifact.path.parent,
        warnings,
        repo_root,
        run_id=run_id,
        summary_artifact=artifact,
    )


def card_supply_from_controller_summary(
    artifact: LoadedArtifact,
    warnings: list[str],
    repo_root: Path,
) -> JsonObject | None:
    candidates = card_supply_candidates_from_controller_summary(artifact, warnings, repo_root)
    if not candidates:
        return None
    return max(candidates, key=card_supply_candidate_key)


def discover_tencent_internal_card_supply_candidates(
    artifact_root: Path,
    *,
    warnings: list[str],
    repo_root: Path,
) -> list[JsonObject]:
    candidates: list[JsonObject] = []
    root = artifact_root / "tencent-cloud" / "batch-runs"
    seen_run_dirs: set[Path] = set()

    for path in existing_globs(root, ("*/controller-summary.json",)):
        artifact = load_artifact(path, warnings, repo_root)
        if artifact is None:
            continue
        candidates.extend(card_supply_candidates_from_controller_summary(artifact, warnings, repo_root))
        seen_run_dirs.add(path.parent)

    if root.is_dir():
        for run_dir in sorted(path for path in root.iterdir() if path.is_dir()):
            if run_dir in seen_run_dirs:
                continue
            candidates.extend(
                card_supply_candidates_from_tencent_run_dir(
                    run_dir,
                    warnings,
                    repo_root,
                    run_id=run_dir.name,
                )
            )

    return sorted(candidates, key=card_supply_candidate_key, reverse=True)


def discover_tencent_internal_card_supply(
    artifact_root: Path,
    *,
    warnings: list[str],
    repo_root: Path,
) -> JsonObject | None:
    candidates = discover_tencent_internal_card_supply_candidates(
        artifact_root,
        warnings=warnings,
        repo_root=repo_root,
    )
    if not candidates:
        return None
    return candidates[0]


def nested_value(value: Any, path: Sequence[str]) -> Any:
    current = value
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def first_number(value: Any, paths: Sequence[Sequence[str]]) -> float | None:
    for path in paths:
        found = number_value(nested_value(value, path))
        if found is not None:
            return found
    return None


def first_text(value: Any, paths: Sequence[Sequence[str]]) -> str | None:
    for path in paths:
        found = text_value(nested_value(value, path))
        if found is not None:
            return found
    return None


def find_first_number_by_keys(value: Any, key_names: Sequence[str]) -> float | None:
    wanted = {normalized_key(name) for name in key_names}
    if isinstance(value, dict):
        for key, item in value.items():
            if normalized_key(str(key)) in wanted:
                found = number_value(item)
                if found is not None:
                    return found
            found = find_first_number_by_keys(item, key_names)
            if found is not None:
                return found
    elif isinstance(value, list):
        for item in value:
            found = find_first_number_by_keys(item, key_names)
            if found is not None:
                return found
    return None


def find_first_text_by_keys(value: Any, key_names: Sequence[str]) -> str | None:
    wanted = {normalized_key(name) for name in key_names}
    if isinstance(value, dict):
        for key, item in value.items():
            if normalized_key(str(key)) in wanted:
                found = text_value(item)
                if found is not None:
                    return found
            found = find_first_text_by_keys(item, key_names)
            if found is not None:
                return found
    elif isinstance(value, list):
        for item in value:
            found = find_first_text_by_keys(item, key_names)
            if found is not None:
                return found
    return None


def merge_reason_counts(target: Counter[str], value: Any) -> None:
    if isinstance(value, dict):
        for key, raw_count in value.items():
            count = number_value(raw_count)
            target[str(key)] += int(count) if count is not None else 1
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, str):
                target[item] += 1


def format_count(value: Any) -> str:
    parsed = number_value(value)
    if parsed is None:
        return "N/A"
    if parsed.is_integer():
        return f"{int(parsed):,}"
    return f"{parsed:,.2f}"


def format_percent(value: Any) -> str:
    parsed = number_value(value)
    if parsed is None:
        return "N/A"
    return f"{parsed * 100:.1f}%"


def h(value: Any) -> str:
    return html.escape(str(value), quote=True)


def display_value(value: Any) -> str:
    if value is None:
        return "N/A"
    return str(value)


def conclusion_summary(artifact: LoadedArtifact | None) -> JsonObject:
    if artifact is None:
        missing_registry_error = (
            "missing conclusion-registry artifact: "
            "runtime-artifacts/rl-control-loop/conclusion-registry.json"
        )
        return {
            "counts": {status: 0 for status in CONCLUSION_STATUSES},
            "otherCounts": {},
            "p0Unresolved": [],
            "linkedIssueGate": rl_conclusion_registry.build_invalid_registry_linked_issue_gate(
                missing_registry_error
            ),
            "latestArtifact": "N/A",
            "updatedAt": "N/A",
            "hasData": False,
        }

    try:
        conclusions_by_id = rl_conclusion_registry.normalize_conclusions(artifact.payload)
    except rl_conclusion_registry.ConclusionRegistryError as error:
        return {
            "counts": {status: 0 for status in CONCLUSION_STATUSES},
            "otherCounts": {},
            "p0Unresolved": [],
            "linkedIssueGate": rl_conclusion_registry.build_invalid_registry_linked_issue_gate(error),
            "latestArtifact": artifact.path,
            "updatedAt": display_timestamp(artifact.payload.get("updatedAt") or artifact.timestamp),
            "hasData": True,
        }
    conclusions = list(conclusions_by_id.values())
    counts = Counter(str(item.get("status", "UNKNOWN")).upper() for item in conclusions)
    p0_unresolved = [
        item
        for item in conclusions
        if str(item.get("severity", "")).upper() == "P0"
        and str(item.get("status", "")).upper() in {"OPEN", "STALE"}
    ]
    p0_unresolved.sort(
        key=lambda item: (
            {"OPEN": 0, "STALE": 1}.get(str(item.get("status", "")).upper(), 9),
            str(item.get("lastSeenAt", "")),
        )
    )
    return {
        "counts": {status: counts.get(status, 0) for status in CONCLUSION_STATUSES},
        "otherCounts": {
            status: count for status, count in sorted(counts.items()) if status not in CONCLUSION_STATUSES
        },
        "p0Unresolved": p0_unresolved[:8],
        "linkedIssueGate": rl_conclusion_registry.build_open_conclusion_linked_issue_gate(conclusions_by_id),
        "latestArtifact": artifact.path,
        "updatedAt": display_timestamp(artifact.payload.get("updatedAt") or artifact.timestamp),
        "hasData": True,
    }


def artifact_kind(path: Path, payload: JsonObject) -> str:
    name = path.name.lower()
    type_text = str(payload.get("type", "")).lower()
    if "training-ledger" in name or "training-execution-ledger" in type_text:
        return "training_ledger"
    if "policy-advantage" in name or "policy-online-advantage" in type_text or "policyadvantage" in normalized_key(type_text):
        return "policy_advantage"
    if "metrics-observations" in name or "metrics-observation" in type_text:
        return "metrics_observations"
    if "conclusion-registry" in name or "conclusion-registry" in type_text:
        return "conclusion_registry"
    if "dataset-evaluation-gate" in type_text or "gate" in name:
        return "gate"
    return "json"


def collect_rejection_reasons(payload: JsonObject) -> Counter[str]:
    reasons: Counter[str] = Counter()
    merge_reason_counts(reasons, payload.get("rejectionReasons"))
    merge_reason_counts(reasons, payload.get("rejection_reasons"))
    quality = as_dict(payload.get("quality_checks")) or as_dict(payload.get("qualityChecks"))
    merge_reason_counts(reasons, quality.get("rejectionReasons"))
    merge_reason_counts(reasons, quality.get("rejection_reasons"))
    for check in as_list(quality.get("checks")):
        if isinstance(check, dict) and str(check.get("status", "")).lower() == "fail":
            rejected = int_value(check.get("rejectedSamples")) or int_value(check.get("samplesRejected")) or 1
            name = text_value(check.get("name")) or "quality_check_failed"
            reasons[name] += rejected
    for blocker in as_list(payload.get("blockingReasons")):
        if isinstance(blocker, dict):
            merge_reason_counts(reasons, blocker.get("rejectionReasons"))
            merge_reason_counts(reasons, blocker.get("rejection_reasons"))
    return reasons


def extract_gate_info(payload: JsonObject, source_path: Path, source_label: str, repo_root: Path) -> JsonObject | None:
    sample_count = first_number(
        payload,
        (
            ("sampleCount",),
            ("datasetGate", "sampleCount"),
            ("dataset", "sampleCount"),
            ("e1Gate", "sampleCount"),
        ),
    )
    accepted = first_number(
        payload,
        (
            ("samplesAccepted",),
            ("samples_accepted",),
            ("datasetGate", "samplesAccepted"),
            ("quality_checks", "samples_accepted"),
            ("e1Gate", "samplesAccepted"),
        ),
    )
    rejected = first_number(
        payload,
        (
            ("samplesRejected",),
            ("samples_rejected",),
            ("datasetGate", "samplesRejected"),
            ("quality_checks", "samples_rejected"),
            ("e1Gate", "samplesRejected"),
        ),
    )

    for blocker in as_list(payload.get("blockingReasons")):
        if not isinstance(blocker, dict):
            continue
        if accepted is None:
            accepted = number_value(blocker.get("samplesAccepted"))
        if rejected is None:
            rejected = number_value(blocker.get("samplesRejected"))

    if sample_count is None and accepted is not None and rejected is not None:
        sample_count = accepted + rejected
    if accepted is None and sample_count is not None and rejected is not None:
        accepted = max(sample_count - rejected, 0)
    if rejected is None and sample_count is not None and accepted is not None:
        rejected = max(sample_count - accepted, 0)

    acceptance = first_number(
        payload,
        (
            ("acceptanceRate",),
            ("acceptance_rate",),
            ("latestGateAcceptanceRate",),
            ("qualityAcceptanceRate",),
            ("quality_checks", "acceptance_rate"),
            ("qualityChecks", "acceptanceRate"),
            ("e1Gate", "acceptanceRate"),
        ),
    )
    if acceptance is None and sample_count not in (None, 0) and accepted is not None:
        acceptance = accepted / sample_count

    gate_id = (
        first_text(payload, (("gateId",), ("e1Gate", "gateId")))
        or text_value(payload.get("source"))
        or source_path.parent.name
    )
    status = (
        first_text(
            payload,
            (
                ("status",),
                ("qualityChecksStatus",),
                ("quality_checks", "status"),
                ("e1Gate", "qualityChecksStatus"),
            ),
        )
        or ("pass" if payload.get("ok") is True else "fail" if payload.get("ok") is False else None)
    )
    if status not in {"pass", "passed", "ok"} and gate_payload_is_acceptable(payload, source_path):
        status = "pass"
    reasons = collect_rejection_reasons(payload)
    timestamp = (
        parse_iso_datetime(payload.get("gateCreatedAt"))
        or parse_iso_datetime(payload.get("createdAt"))
        or parse_iso_datetime(payload.get("window"))
        or timestamp_from_gate_id(payload)
        or artifact_timestamp(source_path, payload)
    )

    if sample_count is None and acceptance is None and not reasons and "gate" not in source_label.lower():
        return None

    return {
        "gateId": gate_id,
        "status": status or "unknown",
        "sampleCount": sample_count,
        "samplesAccepted": accepted,
        "samplesRejected": rejected,
        "acceptanceRate": acceptance,
        "rejectionReasons": reasons,
        "timestamp": timestamp,
        "sourcePath": source_path,
        "sourceLabel": source_label,
        "displayPath": safe_display_path(source_path, repo_root),
    }


def gate_payload_is_acceptable(payload: JsonObject, source_path: Path) -> bool:
    try:
        return experiment_card.is_acceptable_dataset_gate_report(payload, source_path)
    except experiment_card.CardValidationError:
        return False


def gate_info_from_metrics_observations(artifact: LoadedArtifact, repo_root: Path) -> JsonObject | None:
    observations = [item for item in as_list(artifact.payload.get("observations")) if isinstance(item, dict)]
    if not observations:
        return None

    gate_payload: JsonObject = {}
    reasons: Counter[str] = Counter()
    for observation in observations:
        metric = text_value(observation.get("metric"))
        if metric == "latest_gate_acceptance_rate":
            gate_payload["acceptanceRate"] = observation.get("value")
            gate_payload["samplesAccepted"] = observation.get("samplesAccepted")
            gate_payload["samplesRejected"] = observation.get("samplesRejected")
            gate_payload["sampleCount"] = observation.get("sampleCount")
            gate_payload["gateId"] = observation.get("source")
            gate_payload["window"] = observation.get("window")
        elif metric == "quality_rejection_reasons":
            merge_reason_counts(reasons, observation.get("rejectionReasons"))

    if not gate_payload and not reasons:
        return None
    gate_payload["rejectionReasons"] = dict(reasons)
    return extract_gate_info(gate_payload, artifact.path, "metrics observations", repo_root)


def discover_gate_infos(
    artifact_root: Path,
    *,
    repo_root: Path,
    warnings: list[str],
    latest_training: LoadedArtifact | None,
    latest_metrics: LoadedArtifact | None,
) -> list[JsonObject]:
    gate_infos: list[JsonObject] = []

    gate_paths = []
    gate_paths.extend(existing_globs(artifact_root / "rl-dataset-gates", ("*/gate_summary.json", "*/gate_report.json")))
    gate_paths.extend(
        existing_globs(
            artifact_root / "rl-control-loop",
            (
                "*/gate_summary.json",
                "*/gate_report.json",
                "gate-data/*/gate_summary.json",
                "gate-data/*/gate_report.json",
            ),
        )
    )
    gate_paths.extend(existing_globs(artifact_root / "screeps-monitor", ("*gate*.json", "*/gate*.json", "*/*/gate*.json")))

    for path in gate_paths:
        artifact = load_artifact(path, warnings, repo_root)
        if artifact is None:
            continue
        info = extract_gate_info(artifact.payload, artifact.path, "gate artifact", repo_root)
        if info is not None:
            gate_infos.append(info)

    if latest_training is not None:
        e1_gate = as_dict(latest_training.payload.get("e1Gate"))
        if e1_gate:
            info = extract_gate_info(e1_gate, latest_training.path, "training ledger e1Gate", repo_root)
            if info is not None:
                gate_infos.append(info)

    if latest_metrics is not None:
        info = gate_info_from_metrics_observations(latest_metrics, repo_root)
        if info is not None:
            gate_infos.append(info)

    return gate_infos


def latest_gate(gate_infos: Sequence[JsonObject]) -> JsonObject | None:
    if not gate_infos:
        return None
    return max(gate_infos, key=lambda item: item.get("timestamp") or datetime.fromtimestamp(0, tz=timezone.utc))


def simulator_run_dirs(artifact_root: Path) -> list[Path]:
    candidates: list[Path] = []
    for base in (artifact_root / "rl-simulator", artifact_root, artifact_root / "rl-control-loop"):
        if not base.exists():
            continue
        candidates.extend(path for path in base.glob("rl-sim-run*") if path.is_dir())
    return unique_paths(candidates)


def variant_ticks(variant: JsonObject) -> int:
    ticks = first_number(variant, (("ticks_run",), ("ticksRun",), ("metrics", "tickCount")))
    if ticks is None:
        ticks = find_first_number_by_keys(variant, ("ticks_run", "ticksRun", "tickCount"))
    return int(ticks or 0)


def simulator_health(
    artifact_root: Path,
    *,
    repo_root: Path,
    warnings: list[str],
    latest_training: LoadedArtifact | None,
) -> JsonObject:
    run_dirs = simulator_run_dirs(artifact_root)
    succeeded = 0
    failed = 0
    ticks_run = 0
    runs_with_summary = 0
    runs_without_summary = 0
    latest_seen: datetime | None = None
    latest_path: Path | None = None
    failure_modes: Counter[str] = Counter()

    for run_dir in run_dirs:
        summary_path = run_dir / "run_summary.json"
        timestamp = datetime.fromtimestamp(run_dir.stat().st_mtime, tz=timezone.utc)
        if latest_seen is None or timestamp > latest_seen:
            latest_seen = timestamp
            latest_path = run_dir
        if not summary_path.exists():
            runs_without_summary += 1
            failed += 1
            failure_modes["missing_run_summary"] += 1
            continue

        artifact = load_artifact(summary_path, warnings, repo_root)
        if artifact is None:
            runs_without_summary += 1
            failed += 1
            failure_modes["unreadable_run_summary"] += 1
            continue
        runs_with_summary += 1
        if latest_seen is None or artifact.timestamp > latest_seen:
            latest_seen = artifact.timestamp
            latest_path = summary_path

        variants = [item for item in as_list(artifact.payload.get("variants")) if isinstance(item, dict)]
        if variants:
            for variant in variants:
                if variant.get("ok") is True:
                    succeeded += 1
                else:
                    failed += 1
                    error = text_value(variant.get("error")) or "variant_failed"
                    failure_modes[error[:80]] += 1
                ticks_run += variant_ticks(variant)
        else:
            ok = artifact.payload.get("ok")
            if ok is True:
                succeeded += 1
            elif ok is False:
                failed += 1
                failure_modes[text_value(artifact.payload.get("error")) or "run_failed"] += 1
            ticks_run += int(first_number(artifact.payload, (("ticksRun",), ("ticks_run",), ("totalTickRuns",))) or 0)

    source = "simulator run directories"
    if not run_dirs and latest_training is not None:
        execution = as_dict(latest_training.payload.get("environmentExecution"))
        succeeded = int_value(execution.get("Completed")) or int_value(execution.get("completed")) or 0
        failed = int_value(execution.get("Failed")) or int_value(execution.get("failed")) or 0
        ticks_run = int_value(as_dict(latest_training.payload.get("iterationExecution")).get("simulatorTicksRun")) or 0
        latest_seen = parse_iso_datetime(execution.get("lastNewRunAt")) or latest_training.timestamp
        latest_path = latest_training.path
        merge_reason_counts(failure_modes, execution.get("failureModes"))
        source = "training ledger aggregate"

    return {
        "succeeded": succeeded,
        "failed": failed,
        "ticksRun": ticks_run,
        "runCount": len(run_dirs),
        "runsWithSummary": runs_with_summary,
        "runsWithoutSummary": runs_without_summary,
        "latestTimestamp": latest_seen,
        "latestPath": latest_path,
        "failureModes": failure_modes,
        "source": source,
        "hasData": bool(run_dirs) or latest_training is not None,
    }


def card_supply_from_training_payload(payload: JsonObject, path: Path | None) -> JsonObject | None:
    card = as_dict(payload.get("experimentCard"))
    if valid_policy_gradient_card(card, reward_container=payload):
        return loop_a_card_supply_summary(
            card=card,
            path=path,
            source="training_report_experiment_card",
            run_id=text_value(payload.get("reportId")),
        )
    return None


def tencent_card_identity_values(value: JsonObject) -> dict[str, set[str]]:
    identity: dict[str, set[str]] = {field: set() for field in TENCENT_CARD_IDENTITY_FIELDS}
    for key, raw in value.items():
        field = TENCENT_CARD_IDENTITY_KEYS.get(normalized_key(str(key)))
        raw_text = text_value(raw)
        if field is not None and raw_text is not None:
            identity[field].add(raw_text)
    return identity


def tencent_card_identity_candidates(value: Any) -> list[dict[str, set[str]]]:
    candidates: list[dict[str, set[str]]] = []

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            identity = tencent_card_identity_values(node)
            if any(identity[field] for field in TENCENT_CARD_IDENTITY_FIELDS):
                candidates.append(identity)
            for raw in node.values():
                if isinstance(raw, (dict, list)):
                    visit(raw)
        elif isinstance(node, list):
            for item in node:
                visit(item)

    visit(value)
    return candidates


def coherent_tencent_card_identity(value: JsonObject) -> dict[str, set[str]] | None:
    identity = tencent_card_identity_values(value)
    if all(len(identity[field]) == 1 for field in TENCENT_CARD_IDENTITY_FIELDS):
        return identity
    return None


def training_payload_tencent_card_identities(payload: JsonObject) -> list[dict[str, set[str]]]:
    identities: list[dict[str, set[str]]] = []

    def add_identity(value: Any) -> None:
        if not isinstance(value, dict):
            return
        identity = coherent_tencent_card_identity(value)
        if identity is not None and identity not in identities:
            identities.append(identity)

    training_artifacts = as_dict(payload.get("trainingArtifacts"))
    for key, value in training_artifacts.items():
        if normalized_key(str(key)) in {
            "tencentinternalcardsupply",
            "tencentcardsupply",
            "tencentcardidentity",
        }:
            add_identity(value)
    add_identity(training_artifacts)

    for key, value in payload.items():
        if normalized_key(str(key)) in {
            "tencentinternalcardsupply",
            "tencentcardsupply",
            "tencentcardidentity",
        }:
            add_identity(value)
    add_identity(payload)
    return identities


def card_supply_identity(card_supply: JsonObject) -> dict[str, str | None]:
    supply = as_dict(card_supply.get("cardSupply"))
    return {
        "runId": text_value(card_supply.get("runId")),
        "cardId": text_value(card_supply.get("cardId")),
        "datasetRunId": text_value(card_supply.get("datasetRunId"))
        or text_value(first_present(supply, ("dataset_run_id", "datasetRunId"))),
    }


def tencent_card_identity_matches_supply(
    identity: dict[str, set[str]],
    card_supply: JsonObject,
) -> bool:
    supply_identity = card_supply_identity(card_supply)
    for field in TENCENT_CARD_IDENTITY_FIELDS:
        supply_value = supply_identity.get(field)
        if supply_value is None or identity.get(field, set()) != {supply_value}:
            return False
    return True


def training_payload_matches_tencent_card_supply(
    payload: JsonObject,
    card_supply: JsonObject,
) -> bool:
    return any(
        tencent_card_identity_matches_supply(identity, card_supply)
        for identity in training_payload_tencent_card_identities(payload)
    )


def card_supply_blocker_marker_present(value: Any) -> bool:
    text = normalized_key(canonical_json(value))
    return any(marker in text for marker in CARD_SUPPLY_BLOCKER_MARKERS)


def card_supply_blocker_value_active(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    numeric = number_value(value)
    if numeric is not None:
        return numeric > 0
    if isinstance(value, str):
        return normalized_key(value) not in INACTIVE_CARD_SUPPLY_BLOCKER_VALUES
    if isinstance(value, dict):
        return any(card_supply_blocker_value_active(item) for item in value.values())
    if isinstance(value, list):
        return any(card_supply_blocker_value_active(item) for item in value)
    return True


def active_card_supply_blocker_field_present(payload: JsonObject) -> bool:
    for key, value in payload.items():
        normalized = normalized_key(str(key))
        if (
            normalized in CARD_SUPPLY_BLOCKER_FIELD_MARKERS
            and card_supply_blocker_value_active(value)
        ):
            return True
    return False


def card_supply_blocker_text_present(payload: JsonObject) -> bool:
    for field in CARD_SUPPLY_BLOCKER_TEXT_FIELDS:
        if card_supply_blocker_marker_present(payload.get(field)):
            return True
    if active_card_supply_blocker_field_present(payload):
        return True
    for field in CARD_SUPPLY_BLOCKER_OBJECT_FIELDS:
        if active_card_supply_blocker_field_present(as_dict(payload.get(field))):
            return True
    return False


def clear_satisfied_card_supply_blocker(blocker: str | None, card_supply: JsonObject) -> str | None:
    if (
        card_supply.get("status") == "PRIMARY_SATISFIED"
        and blocker
        and card_supply_blocker_marker_present(blocker)
    ):
        return None
    return blocker


def card_supply_available_for_training(card_supply: JsonObject) -> bool:
    supply = as_dict(card_supply.get("cardSupply"))
    if not supply:
        if "cardSupply" in card_supply:
            return False
        return legacy_tencent_card_supply_available_for_training(card_supply)
    return (
        card_supply.get("status") == "PRIMARY_SATISFIED"
        and supply.get("state") == "available"
        and supply.get("available_for_training") is True
        and supply.get("consumed_at") is None
        and supply.get("consumed_by_report_id") is None
    )


def legacy_tencent_card_supply_available_for_training(card_supply: JsonObject) -> bool:
    return (
        card_supply.get("status") == "PRIMARY_SATISFIED"
        and card_supply.get("classification") == "TENCENT_INTERNAL_POLICY_GRADIENT_PRIMARY"
        and card_supply.get("source") in TENCENT_CARD_SUPPLY_SOURCES
        and card_supply.get("hasLoopACardSupplyMetadata") is False
        and text_value(card_supply.get("runId")) is not None
        and text_value(card_supply.get("cardId")) is not None
        and text_value(card_supply.get("datasetRunId")) is not None
    )


def standalone_card_supply_available_for_training(card_supply: JsonObject) -> bool:
    return (
        card_supply.get("source") == STANDALONE_CARD_SUPPLY_SOURCE
        and card_supply_available_for_training(card_supply)
    )


def card_supply_candidate_rank(card_supply: JsonObject) -> int:
    supply = as_dict(card_supply.get("cardSupply"))
    if card_supply_available_for_training(card_supply):
        if supply.get("state") == "available":
            return 3
        return 2
    if supply.get("state") == "consumed":
        return 1
    return 0


def card_supply_candidate_key(card_supply: JsonObject) -> tuple[int, datetime, str, str]:
    created = parse_iso_datetime(text_value(card_supply.get("createdAt")) or "")
    if created is None:
        created = datetime.min.replace(tzinfo=timezone.utc)
    return (
        card_supply_candidate_rank(card_supply),
        created,
        text_value(card_supply.get("source")) or "",
        text_value(card_supply.get("path")) or "",
    )


def training_card_supply_candidate_rank(card_supply: JsonObject) -> int:
    supply = as_dict(card_supply.get("cardSupply"))
    if supply.get("state") == "consumed":
        return 4
    return card_supply_candidate_rank(card_supply)


def training_card_supply_candidate_key(card_supply: JsonObject) -> tuple[int, datetime, str, str]:
    created = parse_iso_datetime(text_value(card_supply.get("createdAt")) or "")
    if created is None:
        created = datetime.min.replace(tzinfo=timezone.utc)
    return (
        training_card_supply_candidate_rank(card_supply),
        created,
        text_value(card_supply.get("source")) or "",
        text_value(card_supply.get("path")) or "",
    )


def combined_tencent_card_supply_candidates(
    tencent_internal_card_supply: JsonObject | None = None,
    tencent_internal_card_supply_candidates: Sequence[JsonObject] | None = None,
) -> list[JsonObject]:
    candidates = list(tencent_internal_card_supply_candidates or [])
    if tencent_internal_card_supply is not None:
        candidates.append(tencent_internal_card_supply)
    return candidates


def combined_card_supply_candidates(
    standalone_card_supply: JsonObject | None = None,
    standalone_card_supply_candidates: Sequence[JsonObject] | None = None,
    tencent_internal_card_supply: JsonObject | None = None,
    tencent_internal_card_supply_candidates: Sequence[JsonObject] | None = None,
) -> list[JsonObject]:
    candidates = list(standalone_card_supply_candidates or [])
    if standalone_card_supply is not None:
        candidates.append(standalone_card_supply)
    candidates.extend(
        combined_tencent_card_supply_candidates(
            tencent_internal_card_supply,
            tencent_internal_card_supply_candidates,
        )
    )
    return candidates


def best_available_card_supply(candidates: Sequence[JsonObject]) -> JsonObject | None:
    available = [candidate for candidate in candidates if card_supply_available_for_training(candidate)]
    if not available:
        return None
    return max(available, key=card_supply_candidate_key)


def best_available_tencent_card_supply(candidates: Sequence[JsonObject]) -> JsonObject | None:
    return best_available_card_supply(candidates)


def matching_tencent_card_supply_for_training(
    payload: JsonObject,
    candidates: Sequence[JsonObject],
) -> JsonObject | None:
    identities = training_payload_tencent_card_identities(payload)
    if not identities:
        return None
    matches = [
        candidate
        for candidate in candidates
        if any(tencent_card_identity_matches_supply(identity, candidate) for identity in identities)
    ]
    if not matches:
        return None
    return max(matches, key=training_card_supply_candidate_key)


def reconcile_card_supply_for_training(
    payload: JsonObject,
    *,
    latest_path: Path | None,
    standalone_card_supply: JsonObject | None = None,
    standalone_card_supply_candidates: Sequence[JsonObject] | None = None,
    tencent_internal_card_supply: JsonObject | None,
    tencent_internal_card_supply_candidates: Sequence[JsonObject] | None = None,
) -> JsonObject:
    compute_evidence = strong_compute_evidence_summary(payload)
    artifact_count = number_value(payload.get("artifactCount"))
    iteration = as_dict(payload.get("iterationExecution"))
    episodes_run = number_value(iteration.get("episodesRun"))
    policy_updates = number_value(iteration.get("policyUpdateIterations"))
    training_claims_compute = (
        payload.get("trainingDidRun") is True
        or status_key(payload.get("status")) in TRAINING_COMPUTE_CLAIM_STATUS_KEYS
        or (artifact_count or 0) > 0
        or (episodes_run or 0) > 0
        or (policy_updates or 0) > 0
    )
    training_did_run = compute_evidence.get("hasCompute") is True
    embedded_supply = card_supply_from_training_payload(payload, latest_path)
    if training_did_run and embedded_supply is not None:
        return embedded_supply
    tencent_candidates = combined_tencent_card_supply_candidates(
        tencent_internal_card_supply,
        tencent_internal_card_supply_candidates,
    )
    if not training_did_run:
        if training_claims_compute:
            return blocked_card_supply_summary(text_value(compute_evidence.get("blocker")))
        available_supply = best_available_tencent_card_supply(tencent_candidates)
        if available_supply is None:
            available_supply = best_available_card_supply(
                combined_card_supply_candidates(
                    standalone_card_supply,
                    standalone_card_supply_candidates,
                )
            )
        if available_supply is not None:
            return dict(available_supply)
    else:
        matching_supply = matching_tencent_card_supply_for_training(payload, tencent_candidates)
        if matching_supply is not None:
            return dict(matching_supply)
    if training_did_run:
        return {
            "status": "DEGRADED",
            "classification": "TRAINING_RAN_WITHOUT_STRUCTURED_CARD_SUPPLY_EVIDENCE",
            "source": None,
            "severity": "P2",
            "fallbackStatus": "DEGRADED",
            "fallbackSeverity": "P2",
            "reason": (
                "Training ran, but no structured safety-validated Tencent or standalone card evidence was found "
                "for dashboard reconciliation."
            ),
        }
    return blocked_card_supply_summary()


def training_execution(
    latest_training: LoadedArtifact | None,
    *,
    standalone_card_supply: JsonObject | None = None,
    standalone_card_supply_candidates: Sequence[JsonObject] | None = None,
    tencent_internal_card_supply: JsonObject | None = None,
    tencent_internal_card_supply_candidates: Sequence[JsonObject] | None = None,
) -> JsonObject:
    if latest_training is None:
        return {
            "hasData": False,
            "status": "N/A",
            "rawStatus": "N/A",
            "episodes": None,
            "policyUpdates": None,
            "timestamp": None,
            "blocker": "No training ledger found.",
            "latestPath": None,
            "cardSupply": blocked_card_supply_summary("No training ledger found."),
            "hasComputeEvidence": False,
            "computeEvidence": {
                "hasCompute": False,
                "classification": "MISSING_COMPUTE_EVIDENCE",
                "signals": [],
                "blocker": "No training ledger found.",
            },
            "identity": {},
        }
    payload = latest_training.payload
    compute_evidence = compute_evidence_summary(payload)
    iteration = as_dict(payload.get("iterationExecution"))
    metrics_feed = as_dict(as_dict(payload.get("metricsFeed")).get("forIssue906"))
    episodes = number_value(iteration.get("episodesRun"))
    if episodes is None:
        episodes = number_value(metrics_feed.get("episodesRun"))
    updates = number_value(iteration.get("policyUpdateIterations"))
    if updates is None:
        updates = number_value(payload.get("policyUpdateIterations"))
    if updates is None:
        updates = number_value(metrics_feed.get("policyUpdateIterations"))
    policy_update = as_dict(payload.get("policyUpdate"))
    promotion_gate = as_dict(payload.get("policyUpdatePromotionGate")) or as_dict(policy_update.get("promotionGate"))
    card_supply = reconcile_card_supply_for_training(
        payload,
        latest_path=latest_training.path,
        standalone_card_supply=standalone_card_supply,
        standalone_card_supply_candidates=standalone_card_supply_candidates,
        tencent_internal_card_supply=tencent_internal_card_supply,
        tencent_internal_card_supply_candidates=tencent_internal_card_supply_candidates,
    )
    blocker = text_value(payload.get("trainingBlocker")) or text_value(payload.get("nextTrainingCapabilityAction"))
    blocker = clear_satisfied_card_supply_blocker(blocker, card_supply)
    if (
        payload.get("trainingDidRun") is not True
        and card_supply.get("status") == "BLOCKED"
        and not blocker
    ):
        blocker = text_value(card_supply.get("reason"))
    raw_status = non_blank_text_value(payload.get("status")) or ("RUN" if payload.get("trainingDidRun") else "NOT_RUN")
    effective_status = raw_status
    training_claims_compute = (
        payload.get("trainingDidRun") is True
        or status_key(raw_status) in TRAINING_COMPUTE_CLAIM_STATUS_KEYS
        or (episodes or 0) > 0
        or (updates or 0) > 0
    )
    if compute_evidence.get("classification") == "PREFLIGHT_ONLY_VALIDATION":
        effective_status = "PREFLIGHT_ONLY"
        blocker = text_value(compute_evidence.get("blocker")) or blocker
    elif training_claims_compute and compute_evidence.get("hasCompute") is not True:
        effective_status = "BLOCKED"
        blocker = text_value(compute_evidence.get("blocker")) or blocker
    return {
        "hasData": True,
        "status": effective_status,
        "rawStatus": raw_status,
        "trainingDidRun": payload.get("trainingDidRun"),
        "episodes": episodes,
        "policyUpdates": updates,
        "policyUpdatePromotionGate": promotion_gate or None,
        "policyUpdatePromotionStatus": text_value(promotion_gate.get("status")),
        "runtimeConsumedPolicyUpdate": promotion_gate.get("runtimeParameterConsumption") is True,
        "trueGradient": policy_update_evidence_value(payload, policy_update, "trueGradient"),
        "gradientStable": policy_update_evidence_value(payload, policy_update, "gradientStable"),
        "trustedGradientUpdate": policy_update_evidence_value(payload, policy_update, "trustedGradientUpdate"),
        "highVariance": policy_update_evidence_value(payload, policy_update, "highVariance"),
        "gradientEstimation": policy_update_evidence_value(payload, policy_update, "gradientEstimation"),
        "gradientMomentum": policy_update_evidence_value(payload, policy_update, "gradientMomentum"),
        "gradientStability": policy_update_evidence_value(payload, policy_update, "gradientStability"),
        "timestamp": latest_training.timestamp,
        "blocker": blocker,
        "latestPath": latest_training.path,
        "cardSupply": card_supply,
        "hasComputeEvidence": compute_evidence.get("hasCompute") is True,
        "computeEvidence": compute_evidence,
        "identity": collect_policy_training_identities(payload),
    }


def metric_observation_map(latest_metrics: LoadedArtifact | None) -> dict[str, JsonObject]:
    if latest_metrics is None:
        return {}
    observations: dict[str, JsonObject] = {}
    for item in as_list(latest_metrics.payload.get("observations")):
        if isinstance(item, dict) and isinstance(item.get("metric"), str):
            observations[item["metric"]] = item
    return observations


def card_supply_finding_for_policy(payload: JsonObject, training: JsonObject | None) -> JsonObject | None:
    if not card_supply_blocker_text_present(payload):
        return None
    card_supply = as_dict((training or {}).get("cardSupply"))
    if card_supply.get("status") == "PRIMARY_SATISFIED":
        if standalone_card_supply_available_for_training(card_supply):
            return None
        return {
            "status": "FALLBACK_DEGRADED",
            "severity": "P2",
            "classification": "STANDALONE_CARD_SUPPLY_FALLBACK_DEGRADED",
            "reason": (
                "Policy report references standalone Loop A card-path stall, but valid Tencent internal "
                "policy-gradient card evidence satisfies the primary training card supply."
            ),
            "primarySupply": card_supply,
        }
    return {
        "status": "BLOCKED",
        "severity": "P0",
        "classification": "CARD_SUPPLY_BLOCKER_ACTIVE",
        "reason": "Policy report references Loop A card supply stall and no valid primary card evidence was found.",
    }


def policy_compute_evidence(payload: JsonObject, training: JsonObject | None) -> JsonObject:
    evidence = strong_compute_evidence_summary(payload)
    training_evidence = as_dict((training or {}).get("computeEvidence"))
    identity_match = policy_training_identity_match(payload, training)
    if (
        training_evidence.get("hasCompute") is True
        and compute_evidence_summary_has_strong_signal(training_evidence)
        and identity_match is not None
    ):
        signals = list(as_list(evidence.get("signals")))
        signals.append(
            {
                "field": "training.computeEvidence",
                "value": training_evidence.get("classification") or "COMPUTE_CONFIRMED",
            }
        )
        signals.append(
            {
                "field": f"policy.trainingIdentity.{identity_match['kind']}",
                "value": identity_match["value"],
            }
        )
        return {
            "hasCompute": True,
            "classification": "COMPUTE_CONFIRMED",
            "signals": signals[:12],
            "blocker": None,
        }
    if (
        evidence.get("hasCompute") is not True
        and training_evidence.get("classification") == "PREFLIGHT_ONLY_VALIDATION"
        and identity_match is not None
    ):
        return {
            "hasCompute": False,
            "classification": "PREFLIGHT_ONLY_VALIDATION",
            "signals": [],
            "blocker": training_evidence.get("blocker") or evidence.get("blocker"),
        }
    return evidence


def metric_status_claims_advantage(metric: JsonObject) -> bool:
    return status_key(metric.get("status")) in POLICY_ADVANTAGE_METRIC_STATUS_KEYS


def policy_requires_compute(status: str, metrics: Sequence[JsonObject]) -> bool:
    return (
        status_key(status) in POLICY_COMPUTE_CLAIM_STATUS_KEYS
        or any(metric_status_claims_advantage(metric) for metric in metrics)
    )


def guard_policy_metrics_for_compute(metrics: Sequence[JsonObject], has_compute: bool) -> list[JsonObject]:
    guarded: list[JsonObject] = []
    for metric in metrics:
        item = dict(metric)
        if not has_compute and metric_status_claims_advantage(item):
            item["rawStatus"] = item.get("status")
            item["status"] = "BLOCKED_NO_COMPUTE"
        guarded.append(item)
    return guarded


def policy_advantage(
    latest_policy: LoadedArtifact | None,
    latest_metrics: LoadedArtifact | None,
    *,
    training: JsonObject | None = None,
) -> JsonObject:
    observations = metric_observation_map(latest_metrics)
    if latest_policy is None:
        return {
            "hasData": False,
            "status": "N/A",
            "rawStatus": "N/A",
            "candidate": "N/A",
            "baseline": "N/A",
            "timestamp": None,
            "latestPath": None,
            "metrics": [],
            "shadowMetrics": shadow_metrics(observations),
            "cardSupplyFinding": None,
            "hasComputeEvidence": False,
            "computeEvidence": {
                "hasCompute": False,
                "classification": "MISSING_COMPUTE_EVIDENCE",
                "signals": [],
                "blocker": "No policy advantage artifact found.",
            },
            "blocker": "No policy advantage artifact found.",
        }

    payload = latest_policy.payload
    metrics: list[JsonObject] = []
    for key, value in as_dict(payload.get("metricsByCategory")).items():
        if not isinstance(value, dict):
            continue
        metrics.append(
            {
                "category": key,
                "status": value.get("status", "UNKNOWN"),
                "candidate": value.get("candidateValue"),
                "baseline": value.get("baselineValue"),
                "delta": value.get("delta"),
            }
        )
    if not metrics:
        for key, value in as_dict(payload.get("metrics")).items():
            if isinstance(value, dict):
                metrics.append({"category": key, "status": value.get("advantage", "UNKNOWN"), "delta": value.get("delta")})

    raw_status = (
        non_blank_text_value(payload.get("onlineUtilityStatus"))
        or non_blank_text_value(payload.get("status"))
        or "UNKNOWN"
    )
    compute_evidence = policy_compute_evidence(payload, training)
    has_compute = compute_evidence.get("hasCompute") is True
    requires_compute = policy_requires_compute(raw_status, metrics)
    status = raw_status
    blocker = None
    if requires_compute and not has_compute:
        status = "BLOCKED"
        blocker = text_value(compute_evidence.get("blocker"))
    guarded_metrics = guard_policy_metrics_for_compute(metrics[:8], has_compute)
    return {
        "hasData": True,
        "status": status,
        "rawStatus": raw_status,
        "candidate": text_value(payload.get("candidatePolicyId")) or "N/A",
        "baseline": text_value(payload.get("baselinePolicyId")) or "N/A",
        "timestamp": latest_policy.timestamp,
        "latestPath": latest_policy.path,
        "metrics": guarded_metrics,
        "shadowMetrics": shadow_metrics(observations),
        "cardSupplyFinding": card_supply_finding_for_policy(payload, training),
        "hasComputeEvidence": has_compute,
        "computeEvidence": compute_evidence,
        "blocker": blocker,
    }


def shadow_metrics(observations: dict[str, JsonObject]) -> JsonObject:
    return {
        "changedTopCount": observations.get("shadow_changed_top_count", {}).get("value"),
        "rankingDiffCount": observations.get("shadow_ranking_diff_count", {}).get("value"),
        "territory": observations.get("shadow_kpi_territory", {}).get("value"),
        "resources": observations.get("shadow_kpi_resources", {}).get("value"),
        "kills": observations.get("shadow_kpi_kills", {}).get("value"),
        "reliabilityPassed": observations.get("shadow_reliability_passed", {}).get("value"),
    }


def lane_statuses(
    gate: JsonObject | None,
    simulator: JsonObject,
    training: JsonObject,
    policy: JsonObject,
) -> list[JsonObject]:
    lanes: list[JsonObject] = []

    if gate is None:
        lanes.append(lane("E1", "shadow-eval", "BLOCKED", None, "No E1 gate artifact found."))
    else:
        acceptance = number_value(gate.get("acceptanceRate"))
        status_text = str(gate.get("status", "")).lower()
        if status_text in {"pass", "passed", "ok"} and acceptance is not None and acceptance >= 0.9:
            status = "OK"
            blocker = "None"
        elif status_text in {"pass", "passed", "ok"}:
            status = "DEGRADED"
            blocker = "Acceptance below 90% target." if acceptance is not None else "Gate passed, acceptance unknown."
        else:
            status = "BLOCKED"
            blocker = "Gate failed or incomplete."
        lanes.append(lane("E1", "shadow-eval", status, gate.get("sourcePath"), blocker))

    if not simulator.get("hasData"):
        lanes.append(lane("E2", "simulator", "BLOCKED", None, "No simulator run data found."))
    elif simulator.get("succeeded", 0) > 0 and simulator.get("failed", 0) == 0:
        lanes.append(lane("E2", "simulator", "OK", simulator.get("latestPath"), "None"))
    elif simulator.get("succeeded", 0) > 0:
        lanes.append(lane("E2", "simulator", "DEGRADED", simulator.get("latestPath"), "Some environments failed."))
    else:
        lanes.append(lane("E2", "simulator", "BLOCKED", simulator.get("latestPath"), "No successful simulator environments."))

    policy_status = str(policy.get("status", "N/A")).upper()
    if not policy.get("hasData"):
        lanes.append(lane("E3", "strategy comparison", "BLOCKED", None, "No policy advantage artifact found."))
    elif policy_status in {"PROVEN", "VALIDATED", "PROMOTABLE", "ADVANTAGE"}:
        lanes.append(lane("E3", "strategy comparison", "OK", policy.get("latestPath"), "None"))
    elif policy_status == "BLOCKED":
        lanes.append(lane("E3", "strategy comparison", "BLOCKED", policy.get("latestPath"), policy.get("blocker") or "Policy advantage is blocked."))
    elif policy_status == "UNPROVEN":
        lanes.append(lane("E3", "strategy comparison", "BLOCKED", policy.get("latestPath"), "Policy advantage remains UNPROVEN."))
    else:
        lanes.append(lane("E3", "strategy comparison", "DEGRADED", policy.get("latestPath"), f"Comparison status {policy_status}."))

    training_status = str(training.get("status", "N/A")).upper()
    episodes = number_value(training.get("episodes"))
    policy_updates = number_value(training.get("policyUpdates"))
    if not training.get("hasData"):
        lanes.append(lane("E4", "training", "BLOCKED", None, "No training ledger found."))
    elif training.get("hasComputeEvidence") is True:
        lanes.append(lane("E4", "training", "OK", training.get("latestPath"), "None"))
    elif training_status in {"NOT_RUN", "BLOCKED", "PREFLIGHT_ONLY"}:
        lanes.append(lane("E4", "training", "BLOCKED", training.get("latestPath"), training.get("blocker") or "Training not running."))
    else:
        lanes.append(lane("E4", "training", "DEGRADED", training.get("latestPath"), training.get("blocker") or training_status))

    if not policy.get("hasData"):
        lanes.append(lane("E5", "rollout", "BLOCKED", None, "No rollout evidence found."))
    elif policy_status in {"PROVEN", "VALIDATED", "PROMOTABLE", "ROLLOUT_APPROVED"}:
        lanes.append(lane("E5", "rollout", "OK", policy.get("latestPath"), "None"))
    elif policy_status == "BLOCKED":
        lanes.append(lane("E5", "rollout", "BLOCKED", policy.get("latestPath"), policy.get("blocker") or "Rollout blocked until compute evidence exists."))
    elif policy_status == "UNPROVEN":
        lanes.append(lane("E5", "rollout", "BLOCKED", policy.get("latestPath"), "Rollout blocked until policy advantage is proven."))
    else:
        lanes.append(lane("E5", "rollout", "DEGRADED", policy.get("latestPath"), f"Rollout status {policy_status}."))

    return lanes


def lane(lane_id: str, name: str, status: str, latest_artifact: Any, blocker: Any) -> JsonObject:
    return {
        "lane": lane_id,
        "name": name,
        "status": status,
        "latestArtifact": latest_artifact,
        "blocker": text_value(blocker) or "N/A",
    }


def build_dashboard(repo_root: Path, artifact_root: Path, generated_at: str) -> JsonObject:
    warnings: list[str] = []
    control_root = artifact_root / "rl-control-loop"

    conclusion_artifact = load_optional_artifact(control_root / "conclusion-registry.json", warnings, repo_root)
    latest_training = latest_artifact(
        control_root,
        ("*training-ledger*.json", "*.json"),
        warnings=warnings,
        repo_root=repo_root,
        predicate=lambda path, payload: artifact_kind(path, payload) == "training_ledger",
    )
    latest_policy = latest_artifact(
        control_root,
        ("*policy-advantage*.json", "*.json"),
        warnings=warnings,
        repo_root=repo_root,
        predicate=lambda path, payload: artifact_kind(path, payload) == "policy_advantage",
    )
    latest_metrics = latest_artifact(
        control_root,
        ("*metrics-observations*.json", "*.json"),
        warnings=warnings,
        repo_root=repo_root,
        predicate=lambda path, payload: artifact_kind(path, payload) == "metrics_observations",
    )

    gates = discover_gate_infos(
        artifact_root,
        repo_root=repo_root,
        warnings=warnings,
        latest_training=latest_training,
        latest_metrics=latest_metrics,
    )
    gate = latest_gate(gates)
    tencent_card_supply_candidates = discover_tencent_internal_card_supply_candidates(
        artifact_root,
        warnings=warnings,
        repo_root=repo_root,
    )
    tencent_card_supply = tencent_card_supply_candidates[0] if tencent_card_supply_candidates else None
    standalone_card_supply_candidates = discover_standalone_card_supply_candidates(
        artifact_root,
        warnings=warnings,
        repo_root=repo_root,
    )
    standalone_card_supply = standalone_card_supply_candidates[0] if standalone_card_supply_candidates else None
    simulator = simulator_health(artifact_root, repo_root=repo_root, warnings=warnings, latest_training=latest_training)
    training = training_execution(
        latest_training,
        standalone_card_supply=standalone_card_supply,
        standalone_card_supply_candidates=standalone_card_supply_candidates,
        tencent_internal_card_supply=tencent_card_supply,
        tencent_internal_card_supply_candidates=tencent_card_supply_candidates,
    )
    policy = policy_advantage(latest_policy, latest_metrics, training=training)
    conclusions = conclusion_summary(conclusion_artifact)
    lanes = lane_statuses(gate, simulator, training, policy)

    return {
        "generatedAt": generated_at,
        "repoRoot": repo_root,
        "artifactRoot": artifact_root,
        "warnings": warnings,
        "artifacts": {
            "conclusionRegistry": conclusion_artifact.path if conclusion_artifact else None,
            "trainingLedger": latest_training.path if latest_training else None,
            "policyAdvantage": latest_policy.path if latest_policy else None,
            "metricsObservations": latest_metrics.path if latest_metrics else None,
        },
        "lanes": lanes,
        "conclusions": conclusions,
        "gate": gate,
        "simulator": simulator,
        "training": training,
        "policy": policy,
        "cardSupply": training.get("cardSupply"),
    }


def render_status(status: str) -> str:
    return f'<span class="status status-{h(status.lower())}">{h(status)}</span>'


def render_lanes(dashboard: JsonObject, repo_root: Path) -> str:
    rows = []
    for row in dashboard["lanes"]:
        latest = safe_display_path(row.get("latestArtifact"), repo_root)
        rows.append(
            "<tr>"
            f"<td>{h(row['lane'])}</td>"
            f"<td>{h(row['name'])}</td>"
            f"<td>{render_status(row['status'])}</td>"
            f"<td>{h(latest)}</td>"
            f"<td>{h(row['blocker'])}</td>"
            "</tr>"
        )
    return table(("Lane", "Name", "Status", "Latest artifact", "Blocker"), rows)


def table(headers: Sequence[str], rows: Sequence[str], empty_label: str = "No data") -> str:
    head = "".join(f"<th>{h(header)}</th>" for header in headers)
    if rows:
        body = "\n".join(rows)
    else:
        body = f'<tr><td colspan="{len(headers)}" class="muted">{h(empty_label)}</td></tr>'
    return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"


def render_conclusions(dashboard: JsonObject, repo_root: Path) -> str:
    summary = dashboard["conclusions"]
    count_rows = [
        f"<tr><td>{h(status)}</td><td>{h(count)}</td></tr>"
        for status, count in summary["counts"].items()
    ]
    for status, count in summary["otherCounts"].items():
        count_rows.append(f"<tr><td>{h(status)}</td><td>{h(count)}</td></tr>")

    unresolved_rows = []
    for item in summary["p0Unresolved"]:
        unresolved_rows.append(
            "<tr>"
            f"<td>{h(item.get('status', 'N/A'))}</td>"
            f"<td>{h(item.get('conclusionId', 'N/A'))}</td>"
            f"<td>{h(item.get('category', 'N/A'))}</td>"
            f"<td>{h(shorten(text_value(item.get('statement')) or 'N/A', 220))}</td>"
            f"<td>{h(item.get('lastSeenAt', 'N/A'))}</td>"
            "</tr>"
        )

    return (
        '<div class="grid two">'
        '<section class="panel"><h2>Conclusion Summary</h2>'
        f'<p class="meta">Registry: {h(safe_display_path(summary["latestArtifact"], repo_root))} | '
        f'Updated: {h(summary["updatedAt"])}</p>'
        f"{table(('Status', 'Count'), count_rows)}</section>"
        '<section class="panel"><h2>P0 OPEN/STALE Conclusions</h2>'
        f"{table(('Status', 'Conclusion', 'Category', 'Statement', 'Last seen'), unresolved_rows)}</section>"
        "</div>"
    )


def shorten(value: str, max_length: int) -> str:
    if len(value) <= max_length:
        return value
    return value[: max_length - 3].rstrip() + "..."


def render_gate(gate: JsonObject | None) -> str:
    if gate is None:
        rows = []
        meta = "Latest gate: N/A"
    else:
        reasons = gate.get("rejectionReasons")
        reason_text = ", ".join(f"{key}={value}" for key, value in reasons.most_common()) if isinstance(reasons, Counter) else "N/A"
        rows = [
            f"<tr><td>Acceptance</td><td>{h(format_percent(gate.get('acceptanceRate')))}</td></tr>",
            f"<tr><td>Sample count</td><td>{h(format_count(gate.get('sampleCount')))}</td></tr>",
            f"<tr><td>Accepted</td><td>{h(format_count(gate.get('samplesAccepted')))}</td></tr>",
            f"<tr><td>Rejected</td><td>{h(format_count(gate.get('samplesRejected')))}</td></tr>",
            f"<tr><td>Rejection reasons</td><td>{h(reason_text or 'None')}</td></tr>",
        ]
        meta = (
            f"Gate: {h(gate.get('gateId', 'N/A'))} | "
            f"Timestamp: {h(display_timestamp(gate.get('timestamp')))} | "
            f"Source: {h(gate.get('displayPath', 'N/A'))}"
        )
    return f'<section class="panel"><h2>E1 Data Quality</h2><p class="meta">{meta}</p>{table(("Metric", "Value"), rows)}</section>'


def render_simulator(simulator: JsonObject, repo_root: Path) -> str:
    failure_modes = simulator.get("failureModes")
    failure_text = "N/A"
    if isinstance(failure_modes, Counter) and failure_modes:
        failure_text = ", ".join(f"{key}={value}" for key, value in failure_modes.most_common(6))
    rows = [
        f"<tr><td>Environments succeeded</td><td>{h(format_count(simulator.get('succeeded')))}</td></tr>",
        f"<tr><td>Environments failed</td><td>{h(format_count(simulator.get('failed')))}</td></tr>",
        f"<tr><td>Ticks run</td><td>{h(format_count(simulator.get('ticksRun')))}</td></tr>",
        f"<tr><td>Run directories</td><td>{h(format_count(simulator.get('runCount')))}</td></tr>",
        f"<tr><td>Last run timestamp</td><td>{h(display_timestamp(simulator.get('latestTimestamp')))}</td></tr>",
        f"<tr><td>Failure modes</td><td>{h(failure_text)}</td></tr>",
    ]
    meta = f"Source: {h(simulator.get('source', 'N/A'))} | Latest: {h(safe_display_path(simulator.get('latestPath'), repo_root))}"
    return f'<section class="panel"><h2>E2 Simulator Health</h2><p class="meta">{meta}</p>{table(("Metric", "Value"), rows)}</section>'


def render_training(training: JsonObject, repo_root: Path) -> str:
    card_supply = as_dict(training.get("cardSupply"))
    compute_evidence = as_dict(training.get("computeEvidence"))
    promotion_status = text_value(training.get("policyUpdatePromotionStatus")) or "N/A"
    card_supply_status = "N/A"
    if card_supply:
        card_supply_status = (
            f"{card_supply.get('status', 'N/A')} / "
            f"fallback {card_supply.get('fallbackStatus', 'N/A')} "
            f"({card_supply.get('fallbackSeverity', card_supply.get('severity', 'N/A'))})"
        )
    rows = [
        f"<tr><td>Status</td><td>{h(training.get('status', 'N/A'))}</td></tr>",
        f"<tr><td>Episodes</td><td>{h(format_count(training.get('episodes')))}</td></tr>",
        f"<tr><td>Policy updates</td><td>{h(format_count(training.get('policyUpdates')))}</td></tr>",
        f"<tr><td>Promotion gate status</td><td>{h(promotion_status)}</td></tr>",
        "<tr><td>Runtime-consumed policy update</td>"
        f"<td>{h(display_value(training.get('runtimeConsumedPolicyUpdate')))}</td></tr>",
        f"<tr><td>Compute evidence</td><td>{h(compute_evidence.get('classification', 'N/A'))}</td></tr>",
        f"<tr><td>Card supply</td><td>{h(card_supply_status)}</td></tr>",
        f"<tr><td>Last ledger timestamp</td><td>{h(display_timestamp(training.get('timestamp')))}</td></tr>",
        f"<tr><td>Blocker</td><td>{h(shorten(training.get('blocker') or 'N/A', 260))}</td></tr>",
    ]
    meta = f"Ledger: {h(safe_display_path(training.get('latestPath'), repo_root))}"
    return f'<section class="panel"><h2>Training Execution</h2><p class="meta">{meta}</p>{table(("Metric", "Value"), rows)}</section>'


def render_policy(policy: JsonObject, repo_root: Path) -> str:
    metric_rows = []
    for item in policy.get("metrics", []):
        if not isinstance(item, dict):
            continue
        metric_rows.append(
            "<tr>"
            f"<td>{h(item.get('category', 'N/A'))}</td>"
            f"<td>{h(item.get('status', 'UNKNOWN'))}</td>"
            f"<td>{h(display_value(item.get('candidate')))}</td>"
            f"<td>{h(display_value(item.get('baseline')))}</td>"
            f"<td>{h(display_value(item.get('delta')))}</td>"
            "</tr>"
        )
    shadow = as_dict(policy.get("shadowMetrics"))
    card_supply_finding = as_dict(policy.get("cardSupplyFinding"))
    compute_evidence = as_dict(policy.get("computeEvidence"))
    shadow_rows = [
        f"<tr><td>compute evidence</td><td>{h(compute_evidence.get('classification', 'N/A'))}</td></tr>",
        f"<tr><td>changedTopCount</td><td>{h(format_count(shadow.get('changedTopCount')))}</td></tr>",
        f"<tr><td>rankingDiffCount</td><td>{h(format_count(shadow.get('rankingDiffCount')))}</td></tr>",
        f"<tr><td>shadow territory KPI</td><td>{h(format_count(shadow.get('territory')))}</td></tr>",
        f"<tr><td>shadow resources KPI</td><td>{h(format_count(shadow.get('resources')))}</td></tr>",
        f"<tr><td>shadow kills KPI</td><td>{h(format_count(shadow.get('kills')))}</td></tr>",
        f"<tr><td>shadow reliability passed</td><td>{h(display_value(shadow.get('reliabilityPassed')))}</td></tr>",
    ]
    if card_supply_finding:
        shadow_rows.append(
            f"<tr><td>card supply finding</td><td>{h(card_supply_finding.get('status', 'N/A'))} "
            f"{h(card_supply_finding.get('severity', 'N/A'))}</td></tr>"
        )
    meta = (
        f"Status: {h(policy.get('status', 'N/A'))} | Candidate: {h(policy.get('candidate', 'N/A'))} | "
        f"Baseline: {h(policy.get('baseline', 'N/A'))} | "
        f"Artifact: {h(safe_display_path(policy.get('latestPath'), repo_root))}"
    )
    return (
        '<section class="panel wide"><h2>Policy Advantage</h2>'
        f'<p class="meta">{meta}</p>'
        '<div class="grid two">'
        f'<div>{table(("Category", "Status", "Candidate", "Baseline", "Delta"), metric_rows)}</div>'
        f'<div>{table(("Shadow metric", "Value"), shadow_rows)}</div>'
        "</div></section>"
    )


def render_artifacts(dashboard: JsonObject, repo_root: Path) -> str:
    rows = [
        f"<tr><td>{h(label)}</td><td>{h(safe_display_path(path, repo_root))}</td></tr>"
        for label, path in dashboard["artifacts"].items()
    ]
    warnings = dashboard.get("warnings", [])
    warning_rows = [f"<tr><td>{h(warning)}</td></tr>" for warning in warnings]
    return (
        '<div class="grid two">'
        f'<section class="panel"><h2>Source Artifacts</h2>{table(("Artifact", "Path"), rows)}</section>'
        f'<section class="panel"><h2>Warnings</h2>{table(("Warning",), warning_rows, "No warnings")}</section>'
        "</div>"
    )


def render_html(dashboard: JsonObject) -> str:
    repo_root = dashboard["repoRoot"]
    artifact_root = dashboard["artifactRoot"]
    generated_at = dashboard["generatedAt"]
    lane_counts = Counter(row["status"] for row in dashboard["lanes"])
    summary = " | ".join(f"{status} {lane_counts.get(status, 0)}" for status in ("OK", "DEGRADED", "BLOCKED"))

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Screeps RL Progress Dashboard</title>
  <style>
    :root {{
      color-scheme: dark;
      --bg: #0c1117;
      --panel: #111a22;
      --panel-2: #0f1720;
      --text: #d7e0ea;
      --muted: #8fa0ae;
      --border: #263340;
      --ok: #45c486;
      --degraded: #f0b84a;
      --blocked: #ff6b6b;
      --accent: #7aa2f7;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      line-height: 1.45;
    }}
    main {{
      width: min(1500px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 20px 0 32px;
    }}
    header {{
      display: grid;
      gap: 8px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 16px;
      margin-bottom: 16px;
    }}
    h1, h2 {{
      margin: 0;
      font-weight: 700;
      letter-spacing: 0;
    }}
    h1 {{ font-size: 22px; }}
    h2 {{ font-size: 15px; margin-bottom: 10px; }}
    .meta, .muted {{
      color: var(--muted);
      margin: 0 0 10px;
    }}
    .summary {{
      color: var(--accent);
      font-weight: 700;
    }}
    .grid {{
      display: grid;
      gap: 12px;
      margin-bottom: 12px;
    }}
    .grid.two {{ grid-template-columns: repeat(2, minmax(0, 1fr)); }}
    .panel {{
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      overflow: hidden;
    }}
    .wide {{ margin-bottom: 12px; }}
    table {{
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      background: var(--panel-2);
      border: 1px solid var(--border);
    }}
    th, td {{
      border-bottom: 1px solid var(--border);
      padding: 6px 8px;
      text-align: left;
      vertical-align: top;
      overflow-wrap: anywhere;
    }}
    th {{
      color: #b8c7d6;
      background: #16212c;
      font-weight: 700;
    }}
    tr:last-child td {{ border-bottom: 0; }}
    .status {{
      display: inline-block;
      min-width: 76px;
      text-align: center;
      border-radius: 4px;
      padding: 2px 6px;
      font-weight: 700;
      color: #091015;
    }}
    .status-ok {{ background: var(--ok); }}
    .status-degraded {{ background: var(--degraded); }}
    .status-blocked {{ background: var(--blocked); }}
    footer {{
      color: var(--muted);
      border-top: 1px solid var(--border);
      padding-top: 14px;
      margin-top: 16px;
    }}
    @media (max-width: 900px) {{
      main {{ width: calc(100vw - 20px); padding-top: 12px; }}
      .grid.two {{ grid-template-columns: 1fr; }}
      body {{ font-size: 12px; }}
      th, td {{ padding: 5px 6px; }}
    }}
  </style>
</head>
<body>
<main>
  <header>
    <h1>Screeps RL Progress Dashboard</h1>
    <div class="summary">{h(summary)}</div>
    <p class="meta">Generated {h(generated_at)} from {h(safe_display_path(artifact_root, repo_root))}. The page is regenerated on each run; no JavaScript auto-refresh is used.</p>
  </header>

  <section class="panel wide">
    <h2>Lane Status</h2>
    {render_lanes(dashboard, repo_root)}
  </section>

  {render_conclusions(dashboard, repo_root)}

  <div class="grid two">
    {render_gate(dashboard["gate"])}
    {render_simulator(dashboard["simulator"], repo_root)}
  </div>

  <div class="grid two">
    {render_training(dashboard["training"], repo_root)}
    <section class="panel"><h2>Auto-Refresh Contract</h2><p class="meta">Run <code>npm run rl-dashboard</code> before refreshing GitHub Pages roadmap evidence at https://lanyusea.github.io/screeps/. The command writes this HTML artifact for local review.</p></section>
  </div>

  {render_policy(dashboard["policy"], repo_root)}
  {render_artifacts(dashboard, repo_root)}

  <footer>Output path: runtime-artifacts/rl-dashboard.html</footer>
</main>
</body>
</html>
"""


def write_text_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = -1
            handle.write(content)
        os.replace(temp_path, path)
    finally:
        if fd != -1:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate runtime-artifacts/rl-dashboard.html.")
    parser.add_argument("--repo-root", type=Path, default=repo_root_from_script(), help="Repository root.")
    parser.add_argument("--artifact-root", type=Path, help="Runtime artifact root. Defaults to <repo>/runtime-artifacts.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="HTML output path.")
    return parser


def resolve_path(path: Path, repo_root: Path) -> Path:
    expanded = path.expanduser()
    return expanded if expanded.is_absolute() else repo_root / expanded


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    repo_root = args.repo_root.expanduser().resolve()
    artifact_root = resolve_path(args.artifact_root, repo_root).resolve() if args.artifact_root else repo_root / "runtime-artifacts"
    output = resolve_path(args.output, repo_root)
    generated_at = utc_now_iso()
    dashboard = build_dashboard(repo_root=repo_root, artifact_root=artifact_root, generated_at=generated_at)
    html_text = render_html(dashboard)
    write_text_atomic(output, html_text)
    print(f"Wrote {safe_display_path(output, repo_root)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
