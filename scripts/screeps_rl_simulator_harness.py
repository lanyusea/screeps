#!/usr/bin/env python3
"""Build a deterministic offline RL simulator-harness manifest."""

from __future__ import annotations

import argparse
import concurrent.futures
import copy
import hashlib
import importlib.util
import json
import math
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence, TextIO

import screeps_rl_dataset_export as dataset_export
import screeps_secret_env


def _load_runtime_monitor_module():
    """Load the sibling screeps-runtime-monitor.py module if the dashed package is unavailable."""
    module_path = Path(__file__).with_name("screeps-runtime-monitor.py")
    if not module_path.exists():
        raise RuntimeError(f"missing runtime monitor module: {module_path}")
    spec = importlib.util.spec_from_file_location("screeps_runtime_monitor", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load runtime monitor module: {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["screeps_runtime_monitor"] = module
    spec.loader.exec_module(module)
    return module


try:
    import screeps_runtime_monitor as runtime_monitor
except ModuleNotFoundError:
    runtime_monitor = _load_runtime_monitor_module()


SCHEMA_VERSION = 1
MANIFEST_TYPE = "screeps-rl-simulator-harness-manifest"
SUMMARY_TYPE = "screeps-rl-simulator-harness-generation"
RUN_SUMMARY_TYPE = "screeps-rl-simulator-run"
DEFAULT_OUT_DIR = Path("runtime-artifacts/rl-simulator-harness")
DEFAULT_RUN_OUT_DIR = Path("runtime-artifacts/rl-simulator")
DEFAULT_SEED = "screeps-rl-simulator-harness-v1"
DEFAULT_WORKERS = 4
DEFAULT_ROOMS_PER_WORKER = 4
DEFAULT_TARGET_SPEEDUP = 100.0
DEFAULT_OFFICIAL_TICK_SECONDS = 3.0
DEFAULT_RUN_TICKS = 100
DEFAULT_RUN_WORKERS = 2
RUN_CONTAINER_DOWN_TIMEOUT_SECONDS = 120
RUN_CONTAINER_UP_TIMEOUT_SECONDS = 900
RUN_CONTAINER_RESTART_TIMEOUT_SECONDS = 240
RUN_PHASE_TIMEOUT_SECONDS = 240
RUN_API_TIMEOUT_SECONDS = 25
DEFAULT_SIM_ROOM = "E1S1"
DEFAULT_SIM_SHARD = "shardX"
DEFAULT_SPAWN_X = 20
DEFAULT_SPAWN_Y = 20
DEFAULT_ACTIVE_WORLD_BRANCH = "$activeWorld"
DEFAULT_BOT_COMMIT = "de2bdfa31cabb2996e73ffe30051a3b375bf5b94"
HARNESS_VERSION = "1.0.0"
REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CODE_PATH = REPO_ROOT / "prod" / "dist" / "main.js"
DEFAULT_MAP_SOURCE_FILE = REPO_ROOT / "maps" / "map-0b6758af.json"
DEFAULT_STRATEGY_REGISTRY_PATH = REPO_ROOT / "prod" / "src" / "strategy" / "strategyRegistry.ts"
RUN_HTTP_START = 21125
RUN_CLI_START = 21126
RUN_HOST_PORT_START_ENV = "SCREEPS_PRIVATE_SMOKE_HOST_PORT_START"
RUN_HTTP_PORT_STEP = 2
RUN_PORT_SCAN_ATTEMPTS = 2048
RUN_TICK_TIMEOUT_SECONDS = 300
RUN_TICK_POLL_SECONDS = 0.20
RUN_WORKER_PREFIX = "rl-sim-worker"
RUN_BROKEN_PIPE_MAX_RETRIES = 1
RUN_BROKEN_PIPE_RETRY_BACKOFF_SECONDS = 2.0
RUN_ID_PREFIX = "rl-sim-run"
RUN_ID_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]+$")
RUN_RESOURCE_GUARD_ALLOW_UNSAFE_ENV = "SCREEPS_RL_SIM_ALLOW_UNSAFE_SCALE"
MULTI_TIER_POLICY_ACTIVATION_TYPE = "screeps-rl-multi-tier-policy-activation"
MULTI_TIER_EXPANSION_ACTIVATION_MIN_SCORE = 12.0
RUNTIME_PARAMETER_INJECTION_TYPE = "screeps-rl-runtime-parameter-injection"
RUNTIME_PARAMETER_INJECTION_MECHANISM = "private_simulator_code_prelude_v1"
RUNTIME_PARAMETER_INJECTION_GLOBAL = "__SCREEPS_RL_RUNTIME_POLICY_PARAMETERS__"
RUNTIME_PARAMETER_CONSUMPTION_GLOBAL = "__SCREEPS_RL_RUNTIME_POLICY_PARAMETER_CONSUMPTION__"
RUNTIME_PARAMETER_CONSUMPTION_TYPE = "screeps-rl-runtime-policy-parameter-consumption"
RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER = "screeps-rl-runtime-policy-parameters-consumer-v1"
STRICT_DIRECTIVE_PREFIX_RE = re.compile(
    r"\A(\ufeff?(?:(?:\s+)|(?://[^\r\n]*(?:\r?\n|$))|(?:/\*.*?\*/))*"
    r"(?:(?:['\"]use strict['\"]\s*;?\s*)+))",
    re.DOTALL,
)
RUN_RESOURCE_GUARD_MIN_WORKERS = 3
RUN_RESOURCE_GUARD_MEMORY_PER_WORKER_MIB = 2300
RUN_RESOURCE_GUARD_HOST_RESERVE_MIB = 1536
RUN_RESOURCE_GUARD_ACTIVE_STACK_MEMORY_MIB = 1400
RUN_RESOURCE_GUARD_NATIVE_BUILD_JOBS_PER_WORKER = 1
RUN_RESOURCE_GUARD_HISTORICAL_NODE_GYP_JOBS_PER_WORKER = 4
RUN_RESOURCE_GUARD_FAILURE_TYPE = "screeps-rl-simulator-resource-guard-failure"
RUN_SCALE_VALIDATION_PLAN_TYPE = "screeps-rl-simulator-scale-validation-plan"
RUN_SCALE_VALIDATION_DEFAULT_MIN_ENVIRONMENTS = 5
DEFAULT_STEAM_KEY_ENV_FILE = screeps_secret_env.DEFAULT_LOCAL_SECRET_ENV_FILE
STEAM_KEY_ENV_FILE_ENV = "SCREEPS_RL_STEAM_KEY_ENV_FILE"
RUN_SCALE_VALIDATION_TARGET_SUCCESS_RATE = 0.8
RUN_SETUP_FAILURE_TYPE = "screeps-rl-simulator-setup-failure"
RUN_FAILURE_TYPE = "screeps-rl-simulator-run-failure"
RUN_DOCKER_CLEANUP_TIMEOUT_SECONDS = 90
SIMULATOR_REPAIR_MOD_FILENAME = "rl-simulator-harness-repair.js"
OWNED_ROOM_SCORECARD_TYPE = "screeps-rl-simulator-owned-room-scorecard"
PRIVATE_MAP_FIXTURE_TYPE = "screeps-rl-private-map-fixture"
_WORKER_PHASE_DEBUG_DISABLED = False
SCALE_ENVIRONMENT_VARIANT_RE = re.compile(r"^(?P<base>.+)\.scale-env-(?P<index>\d{2,})$")
ROOM_NAME_RE = re.compile(r"^(?P<horizontal>[WE])(?P<x>\d+)(?P<vertical>[NS])(?P<y>\d+)$")
HARNESS_EXCLUDED_DIRECTORY_NAMES = ("node_modules", ".git", "__pycache__")
HARNESS_BINARY_FILE_EXTENSIONS = (
    ".bmp",
    ".gif",
    ".gz",
    ".ico",
    ".jpeg",
    ".jpg",
    ".png",
    ".sqlite",
    ".sqlite3",
    ".zip",
)
NON_STRUCTURE_OBJECT_TYPES = {
    "creep",
    "controller",
    "source",
    "mineral",
    "deposit",
    "resource",
    "tombstone",
    "ruin",
    "flag",
}
ROOM_ENERGY_CAPACITY_FALLBACKS = {
    "spawn": 300,
    "extension": 50,
}
ENERGY_STORAGE_OBJECT_TYPES = {
    "spawn",
    "extension",
    "tower",
    "link",
    "storage",
    "terminal",
    "container",
    "factory",
    "lab",
    "nuker",
    "powerSpawn",
}
SIMULATOR_REPAIR_MOD_SOURCE = """\
const bodyParser = require('body-parser');
const zlib = require('zlib');
const common = require('@screeps/common');

const plainTerrain = '0'.repeat(2500);

function buildFallbackTerrainData(accessibleRoomsJson) {
  let rooms = [];
  try {
    const parsed = JSON.parse(accessibleRoomsJson || '[]');
    if (Array.isArray(parsed)) {
      rooms = parsed.filter(room => typeof room === 'string');
    }
  } catch (err) {
    rooms = [];
  }
  const payload = rooms.map(room => ({ room, terrain: plainTerrain }));
  return zlib.deflateSync(Buffer.from(JSON.stringify(payload))).toString('base64');
}

function installStorageFallback(storage) {
  const env = storage && storage.env;
  if (!env || !env.keys || typeof env.get !== 'function' || env.__rlSimulatorHarnessRepairInstalled) {
    return;
  }
  const originalGet = env.get.bind(env);
  env.get = key => Promise.resolve(originalGet(key)).then(value => {
    if ((value === null || value === undefined) && key === env.keys.ACCESSIBLE_ROOMS) {
      return '[]';
    }
    if ((value === null || value === undefined) && key === env.keys.TERRAIN_DATA) {
      return Promise.resolve(originalGet(env.keys.ACCESSIBLE_ROOMS))
        .then(buildFallbackTerrainData)
        .catch(() => buildFallbackTerrainData('[]'));
    }
    return value;
  });
  env.__rlSimulatorHarnessRepairInstalled = true;
}

module.exports = config => {
  const storage = (config.common && config.common.storage) || common.storage;
  installStorageFallback(storage);
  if (storage && typeof storage._connect === 'function' && !storage.__rlSimulatorHarnessConnectPatched) {
    const originalConnect = storage._connect.bind(storage);
    storage._connect = (...args) => originalConnect(...args).then(result => {
      installStorageFallback(storage);
      return result;
    });
    storage.__rlSimulatorHarnessConnectPatched = true;
  }

  if (config.backend) {
    config.backend.on('expressPreConfig', app => {
      app.use('/api/user/code', bodyParser.json({ limit: '8mb' }));
    });
  }
};
"""

JsonObject = dict[str, Any]
_smoke_module = None


def resolve_bot_commit(bot_commit: str | None = None, repo_root: Path | None = None) -> str:
    if bot_commit:
        return bot_commit
    repo = repo_root or REPO_ROOT
    detected = dataset_export.git_commit(repo)
    return detected if detected and detected != "unknown" else DEFAULT_BOT_COMMIT


DEFAULT_STRATEGY_VARIANT_CONFIGS: tuple[JsonObject, ...] = (
    {
        "id": "construction-priority.incumbent.v1",
        "label": "Construction-priority incumbent",
        "family": "construction-priority",
        "rolloutStatus": "incumbent",
        "source": "prod/src/strategy/strategyRegistry.ts",
        "mechanism": "construction-priority shadow weight-vector",
        "defaultValues": {
            "baseScoreWeight": 1,
            "territorySignalWeight": 6,
            "resourceSignalWeight": 4,
            "killSignalWeight": 6,
            "riskPenalty": 4,
        },
        "shadowConfig": {
            "enabled": True,
            "incumbentStrategyIds": {"construction-priority": "construction-priority.incumbent.v1"},
            "candidateStrategyIds": ["construction-priority.incumbent.v1"],
        },
        "rollback": {
            "disabledByDefault": False,
            "rollbackToStrategyId": "construction-priority.incumbent.v1",
        },
        "safety": {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        },
    },
    {
        "id": "construction-priority.container-prioritized-shadow.v1",
        "label": "Container-prioritized construction shadow",
        "family": "construction-priority",
        "rolloutStatus": "shadow",
        "source": "scripts/screeps_rl_simulator_harness.py",
        "mechanism": "construction-priority shadow weight-vector",
        "defaultValues": {
            "baseScoreWeight": 1,
            "territorySignalWeight": 5,
            "resourceSignalWeight": 18,
            "killSignalWeight": 3,
            "riskPenalty": 3,
        },
        "shadowConfig": {
            "enabled": True,
            "incumbentStrategyIds": {"construction-priority": "construction-priority.incumbent.v1"},
            "candidateStrategyIds": ["construction-priority.container-prioritized-shadow.v1"],
        },
        "focus": {
            "constructionPriority": ["container", "source container", "controller container"],
            "reason": "High resource weight favors container-oriented candidates while preserving territory-first scoring.",
        },
        "rollback": {
            "disabledByDefault": True,
            "rollbackToStrategyId": "construction-priority.incumbent.v1",
        },
        "safety": {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        },
    },
)


def parse_variants_csv(raw: str) -> list[str]:
    """Parse a comma-separated variant list from CLI input."""
    variants: list[str] = []
    for token in raw.split(","):
        trimmed = token.strip()
        if not trimmed:
            continue
        if trimmed not in variants:
            variants.append(trimmed)
    return variants


def default_strategy_variant_configs() -> list[JsonObject]:
    """Return the simulator's default construction-priority variant configs."""
    return copy.deepcopy(list(DEFAULT_STRATEGY_VARIANT_CONFIGS))


def default_strategy_variant_ids() -> list[str]:
    """Return the default variant ids used when `run --variants` is omitted."""
    return [str(config["id"]) for config in DEFAULT_STRATEGY_VARIANT_CONFIGS]


def available_strategy_variants(discovered: Sequence[str]) -> list[str]:
    """Merge built-in simulator variants with registry-discovered strategy ids."""
    variants = default_strategy_variant_ids()
    for variant_id in discovered:
        if variant_id not in variants:
            variants.append(variant_id)
    return variants


def scale_environment_base_variant_id(variant_id: str) -> str:
    """Return the strategy variant backing a generated scale-environment row."""
    match = SCALE_ENVIRONMENT_VARIANT_RE.fullmatch(variant_id)
    return match.group("base") if match else variant_id


def scale_environment_index(variant_id: str) -> int | None:
    """Return the one-based scale-environment index encoded in a generated row id."""
    match = SCALE_ENVIRONMENT_VARIANT_RE.fullmatch(variant_id)
    if not match:
        return None
    try:
        return int(match.group("index"))
    except ValueError:
        return None


def expand_scale_environment_variants(variant_ids: Sequence[str], environment_count: int | None) -> list[str]:
    """Return unique simulator rows for a requested concurrent environment count.

    The run harness historically mapped concurrency to strategy variant rows. A
    scale proof may need five private-server environments while only comparing
    the two default construction-priority variants, so this expansion creates
    unique environment row ids backed by the selected base variants. The
    requested count is a replica budget, not permission to drop selected
    strategy variants.
    """
    variants = [variant_id for variant_id in variant_ids if isinstance(variant_id, str) and variant_id]
    if environment_count is None:
        return list(variants)
    if environment_count <= 0:
        raise ValueError("environment_count must be a positive integer")
    if not variants:
        raise ValueError("at least one strategy variant is required")
    row_count = max(environment_count, len(variants))
    if row_count == len(variants):
        return list(variants)
    width = max(2, len(str(row_count)))
    return [
        f"{variants[index % len(variants)]}.scale-env-{index + 1:0{width}d}"
        for index in range(row_count)
    ]


def _normalized_inline_strategy_variant_config(variant_id: str, raw_config: Mapping[str, Any]) -> JsonObject:
    """Return a sanitized offline strategy config supplied by the training runner."""
    config = copy.deepcopy(dict(raw_config))
    config["id"] = variant_id
    if not isinstance(config.get("label"), str) or not config["label"]:
        title = config.get("title")
        config["label"] = title if isinstance(title, str) and title else variant_id
    config.setdefault("family", "construction-priority")
    config.setdefault("rolloutStatus", config.get("rollout_status") or "inline")
    config.setdefault("source", "inline-policy-gradient-candidate")
    parameters = config.get("parameters")
    if isinstance(parameters, dict) and not isinstance(config.get("defaultValues"), dict):
        config["defaultValues"] = copy.deepcopy(parameters)
    safety = config.get("safety") if isinstance(config.get("safety"), dict) else {}
    config["safety"] = {
        **safety,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
    }
    return config


def _scale_environment_strategy_variant_config(
    variant_id: str,
    base_config: Mapping[str, Any],
    *,
    rewrite_label: bool = True,
) -> JsonObject:
    base_variant_id = scale_environment_base_variant_id(variant_id)
    environment_index = scale_environment_index(variant_id)
    config = copy.deepcopy(dict(base_config))
    config["id"] = variant_id
    if rewrite_label or not isinstance(config.get("label"), str) or not config["label"]:
        base_label = config.get("label") if isinstance(config.get("label"), str) else base_variant_id
        config["label"] = (
            f"{base_label} scale environment {environment_index}"
            if environment_index is not None
            else f"{base_label} scale environment"
        )
    config["sourceVariantId"] = base_variant_id
    config["scaleEnvironment"] = {
        "enabled": True,
        "environmentIndex": environment_index,
        "baseVariantId": base_variant_id,
        "purpose": "unique simulator environment row for concurrent E2 scale validation",
    }
    config["safety"] = {
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
    }
    return config


def strategy_variant_config_by_id(
    variant_id: str,
    variant_configs: Mapping[str, JsonObject] | None = None,
) -> JsonObject:
    """Return bounded public config for a strategy variant id."""
    base_variant_id = scale_environment_base_variant_id(variant_id)
    if variant_configs is not None:
        override = variant_configs.get(variant_id)
        if isinstance(override, dict):
            config = _normalized_inline_strategy_variant_config(variant_id, override)
            if base_variant_id != variant_id:
                return _scale_environment_strategy_variant_config(
                    variant_id,
                    config,
                    rewrite_label=False,
                )
            return config
    if base_variant_id != variant_id:
        base_config = strategy_variant_config_by_id(base_variant_id, variant_configs=variant_configs)
        return _scale_environment_strategy_variant_config(variant_id, base_config)
    for config in DEFAULT_STRATEGY_VARIANT_CONFIGS:
        if config.get("id") == variant_id:
            return copy.deepcopy(config)
    return {
        "id": variant_id,
        "label": variant_id,
        "family": None,
        "rolloutStatus": "registry",
        "source": "prod/src/strategy/strategyRegistry.ts",
        "mechanism": "strategy registry id",
        "safety": {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        },
    }


def resolve_strategy_variant_configs(
    variant_ids: Sequence[str],
    variant_configs: Mapping[str, JsonObject] | None = None,
) -> list[JsonObject]:
    """Return variant config objects in the same order as the selected ids."""
    return [strategy_variant_config_by_id(variant_id, variant_configs=variant_configs) for variant_id in variant_ids]


def discover_strategy_variants(path: Path = DEFAULT_STRATEGY_REGISTRY_PATH) -> list[str]:
    """Return variant ids from the strategy registry TypeScript source."""
    if not path.exists():
        raise RuntimeError(f"strategy registry file not found: {path}")
    text = path.read_text(encoding="utf-8")
    pattern = re.compile(r"^\s*id:\s*['\"](?P<variant>[^'\"]+)['\"]", re.MULTILINE)
    variants: list[str] = []
    for match in pattern.finditer(text):
        variant_id = match.group("variant").strip()
        if variant_id and variant_id not in variants:
            variants.append(variant_id)
    if not variants:
        raise RuntimeError(f"no strategy variants found in registry: {path}")
    return variants


def normalize_variants(
    requested: Sequence[str] | None,
    available: Sequence[str],
) -> list[str]:
    """Combine `--variants` inputs with the two default construction-priority variants."""
    if not requested:
        return default_strategy_variant_ids()
    selected: list[str] = []
    for raw in requested:
        for variant in parse_variants_csv(raw):
            if variant and variant not in selected:
                selected.append(variant)
    if not selected:
        return default_strategy_variant_ids()
    missing = sorted(set(selected) - set(available))
    if missing:
        raise RuntimeError(f"unknown strategy variants: {', '.join(missing)}")
    return selected


def _safe_text(value: Any, max_len: int = 320) -> str:
    text = dataset_export.redact_text(str(value))
    return text[:max_len]


def _text_mentions_broken_pipe(value: Any) -> bool:
    text = str(value).lower()
    return "broken pipe" in text or "errno 32" in text


def _variant_result_mentions_broken_pipe(result: JsonObject) -> bool:
    if _text_mentions_broken_pipe(result.get("error")):
        return True
    errors = result.get("errors")
    if isinstance(errors, list):
        return any(_text_mentions_broken_pipe(error) for error in errors)
    return False


def _safe_filename(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", value)
    safe = re.sub(r"-+", "-", safe).strip("-.")
    return safe or "variant"


def runtime_parameter_injection_for_variant(
    variant_id: str,
    strategy_variant: Mapping[str, Any],
) -> JsonObject:
    """Build the offline-only policy-parameter payload injected into a private simulator code upload."""
    parameters = _strategy_variant_parameters(dict(strategy_variant))
    if not parameters:
        return {
            "type": RUNTIME_PARAMETER_INJECTION_TYPE,
            "schemaVersion": SCHEMA_VERSION,
            "status": "skipped",
            "runtimeParameterInjection": False,
            "inlineCandidatesRuntimeInjected": False,
            "candidateParameterScope": "metadata_only",
            "mechanism": RUNTIME_PARAMETER_INJECTION_MECHANISM,
            "strategyVariantId": variant_id,
            "reason": "strategy variant did not provide parameters to inject",
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
            "safety": safety_metadata(),
        }

    payload = {
        "type": RUNTIME_PARAMETER_INJECTION_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "status": "prepared",
        "runtimeParameterInjection": False,
        "inlineCandidatesRuntimeInjected": False,
        "candidateParameterScope": "runtime_injected",
        "mechanism": RUNTIME_PARAMETER_INJECTION_MECHANISM,
        "globalName": RUNTIME_PARAMETER_INJECTION_GLOBAL,
        "strategyVariantId": variant_id,
        "candidatePolicyId": strategy_variant.get("candidatePolicyId"),
        "sourceStrategyId": strategy_variant.get("sourceStrategyId"),
        "family": strategy_variant.get("family"),
        "parameters": copy.deepcopy(parameters),
        "parametersSha256": hashlib.sha256(
            json.dumps(parameters, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        ).hexdigest(),
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
    }
    return {key: value for key, value in payload.items() if value is not None}


def apply_runtime_parameter_injection_to_code(code_text: str, injection: JsonObject) -> str:
    if injection.get("status") not in {"prepared", "injected"}:
        return code_text
    if injection.get("candidateParameterScope") != "runtime_injected":
        return code_text
    runtime_payload = copy.deepcopy(injection)
    runtime_payload["status"] = "injected"
    runtime_payload["runtimeParameterInjection"] = True
    runtime_payload["inlineCandidatesRuntimeInjected"] = True
    prelude = (
        "/* screeps-rl private-simulator runtime parameter injection; "
        "liveEffect=false officialMmoWrites=false officialMmoWritesAllowed=false */\n"
        "(function(){\n"
        f"  var payload = {json.dumps(runtime_payload, sort_keys=True, separators=(',', ':'), ensure_ascii=True)};\n"
        "  var root = typeof globalThis !== 'undefined' ? globalThis : "
        "(typeof global !== 'undefined' ? global : this);\n"
        f"  root[{json.dumps(RUNTIME_PARAMETER_INJECTION_GLOBAL)}] = payload;\n"
        "})();\n"
    )
    insert_at = runtime_parameter_injection_insert_index(code_text)
    return code_text[:insert_at] + prelude + code_text[insert_at:]


def runtime_parameter_injection_insert_index(code_text: str) -> int:
    match = STRICT_DIRECTIVE_PREFIX_RE.match(code_text)
    return match.end() if match is not None else 0


def mark_runtime_parameter_injection_uploaded(
    injection: JsonObject,
    *,
    code_text: str,
) -> JsonObject:
    updated = copy.deepcopy(injection)
    if updated.get("status") == "prepared":
        updated["uploadedCodeSha256"] = hashlib.sha256(code_text.encode("utf-8")).hexdigest()
        updated["uploadedCodeBytes"] = len(code_text.encode("utf-8"))
        if not runtime_parameter_injection_code_has_consumer(code_text):
            updated["status"] = "failed"
            updated["runtimeParameterInjection"] = False
            updated["inlineCandidatesRuntimeInjected"] = False
            updated["reason"] = (
                "uploaded bot bundle did not include the runtime policy parameter consumer marker"
            )
            updated["runtimeParameterConsumer"] = RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER
            updated["runtimeParameterConsumerObserved"] = False
            return updated
        updated["status"] = "injected"
        updated["runtimeParameterInjection"] = True
        updated["inlineCandidatesRuntimeInjected"] = True
        updated["runtimeParameterConsumer"] = RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER
        updated["runtimeParameterConsumerObserved"] = True
    return updated


def runtime_parameter_injection_code_has_consumer(code_text: str) -> bool:
    return RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER in code_text


def runtime_parameter_consumption_check(
    injection: JsonObject,
    evidence: Any,
    *,
    source_errors: Sequence[str] = (),
) -> JsonObject:
    """Validate runtime-side evidence that the bot consumed injected policy parameters."""
    base = {
        "type": RUNTIME_PARAMETER_CONSUMPTION_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "consumerMarker": RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER,
        "runtimeParameterConsumption": False,
        "runtimeParameterInjectionStatus": injection.get("status"),
        "strategyVariantId": injection.get("strategyVariantId"),
        "candidatePolicyId": injection.get("candidatePolicyId"),
        "parametersSha256": injection.get("parametersSha256"),
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
    }
    if injection.get("status") != "injected" or injection.get("runtimeParameterInjection") is not True:
        return {
            **{key: value for key, value in base.items() if value is not None},
            "status": "not_attempted",
            "reason": "runtime parameter upload was not injected",
        }

    if not isinstance(evidence, dict):
        reason = "simulator run did not expose runtime policy parameter consumption evidence"
        if source_errors:
            reason += ": " + "; ".join(str(error) for error in source_errors[:3])
        return {
            **{key: value for key, value in base.items() if value is not None},
            "status": "missing",
            "reason": reason,
        }

    validation_error = runtime_parameter_consumption_validation_error(injection, evidence)
    if validation_error is not None:
        payload = {
            **{key: value for key, value in base.items() if value is not None},
            "status": "invalid",
            "reason": validation_error,
        }
        observed_hash = runtime_consumption_parameters_hash(evidence)
        if observed_hash is not None:
            payload["evaluatedParametersSha256"] = observed_hash
        if text_or_none(evidence.get("source")):
            payload["source"] = text_or_none(evidence.get("source"))
        return payload

    parameters = copy.deepcopy(evidence["parameters"])
    parameters_hash = runtime_consumption_parameters_hash(evidence)
    payload = {
        **{key: value for key, value in base.items() if value is not None},
        "status": "consumed",
        "runtimeParameterConsumption": True,
        "consumed": True,
        "source": text_or_none(evidence.get("source")) or "runtime_policy_parameter_consumption",
        "evaluatedParameters": parameters,
        "evaluatedParametersSha256": parameters_hash,
        "appliedStrategyIds": copy.deepcopy(evidence.get("appliedStrategyIds", [])),
        "evidence": copy.deepcopy(evidence),
    }
    return {key: value for key, value in payload.items() if value is not None}


def apply_runtime_parameter_consumption_to_injection(
    injection: JsonObject,
    consumption: JsonObject,
) -> JsonObject:
    updated = copy.deepcopy(injection)
    updated["runtimeParameterConsumption"] = consumption.get("runtimeParameterConsumption") is True
    updated["runtimeParameterConsumptionStatus"] = consumption.get("status")
    if consumption.get("reason"):
        updated["runtimeParameterConsumptionReason"] = consumption.get("reason")
    if consumption.get("source"):
        updated["runtimeParameterConsumptionSource"] = consumption.get("source")
    if consumption.get("evaluatedParametersSha256"):
        updated["evaluatedParametersSha256"] = consumption.get("evaluatedParametersSha256")
    return updated


def runtime_parameter_consumption_validation_error(
    injection: JsonObject,
    evidence: JsonObject,
) -> str | None:
    if evidence.get("type") != RUNTIME_PARAMETER_CONSUMPTION_TYPE:
        return "runtime policy parameter evidence had the wrong type"
    if evidence.get("consumerMarker") != RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER:
        return "runtime policy parameter evidence did not come from the expected consumer"
    if evidence.get("consumed") is not True or evidence.get("runtimeParameterInjection") is not True:
        return "runtime policy parameter evidence did not mark the payload consumed"
    parameters = evidence.get("parameters")
    if not isinstance(parameters, dict) or not parameters:
        return "runtime policy parameter evidence did not include consumed parameters"
    observed_hash = runtime_consumption_parameters_hash(evidence)
    expected_hash = text_or_none(injection.get("parametersSha256"))
    if observed_hash is None:
        return "runtime policy parameter evidence parameters could not be hashed"
    if expected_hash is not None and observed_hash != expected_hash:
        return "runtime policy parameter evidence parameters disagreed with injected parameters"
    for field in ("strategyVariantId", "candidatePolicyId", "family"):
        expected = text_or_none(injection.get(field))
        observed = text_or_none(evidence.get(field))
        if expected is not None and observed is not None and observed != expected:
            return f"runtime policy parameter evidence {field} disagreed with injected parameters"
    for field in ("liveEffect", "officialMmoWrites", "officialMmoWritesAllowed"):
        if evidence.get(field) is True:
            return f"runtime policy parameter evidence set unsafe {field}=true"
    return None


def runtime_consumption_parameters_hash(evidence: JsonObject) -> str | None:
    parameters = evidence.get("parameters")
    if not isinstance(parameters, dict):
        return None
    return hashlib.sha256(
        json.dumps(parameters, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    ).hexdigest()


def runtime_parameter_record_matches_username(value: Any, username: str | None) -> bool:
    expected = _non_empty_text(username)
    if expected is None or not isinstance(value, dict):
        return True
    observed = _runtime_parameter_explicit_owner_username(value)
    return observed is None or observed == expected


def _runtime_parameter_explicit_owner_username(value: JsonObject) -> str | None:
    for field in ("username", "ownerUsername", "owner_username", "userName", "user_name"):
        observed = _non_empty_text(value.get(field))
        if observed is not None:
            return observed
    for field in ("owner", "user"):
        nested = value.get(field)
        if isinstance(nested, dict):
            observed = _runtime_parameter_nested_owner_username(nested)
            if observed is not None:
                return observed
        elif field == "owner":
            observed = _runtime_parameter_scalar_owner_username(nested)
            if observed is not None:
                return observed
    return None


def _runtime_parameter_nested_owner_username(value: JsonObject) -> str | None:
    for field in ("username", "ownerUsername", "owner_username", "userName", "user_name", "name"):
        observed = _non_empty_text(value.get(field))
        if observed is not None:
            return observed
    return None


def _runtime_parameter_scalar_owner_username(value: Any) -> str | None:
    observed = _non_empty_text(value)
    if observed is None or re.fullmatch(r"[0-9a-fA-F]{24}", observed):
        return None
    return observed


def collect_runtime_parameter_consumption_evidence(
    smoke: Any,
    compose: Sequence[str] | None,
    cfg: Any,
    token: str | None,
    injection: JsonObject | None = None,
) -> tuple[JsonObject | None, list[str]]:
    errors: list[str] = []
    collectors = [
        ("Memory.rlRuntimePolicyParameters", _collect_http_runtime_parameter_consumption_evidence),
        ("redis.Memory.rlRuntimePolicyParameters", _collect_redis_runtime_parameter_consumption_evidence),
        ("mongo.Memory.rlRuntimePolicyParameters", _collect_mongo_runtime_parameter_consumption_evidence),
    ]
    invalid_evidence: JsonObject | None = None
    for source, collector in collectors:
        try:
            evidence = collector(smoke, compose, cfg, token, injection)
        except Exception as exc:  # noqa: BLE001 - missing evidence blocks eligibility but should not fail the run
            errors.append(f"{source} failed: {_safe_text(exc, 240)}")
            continue
        if evidence is not None:
            evidence = copy.deepcopy(evidence)
            evidence["source"] = source
            if injection is not None:
                validation_error = runtime_parameter_consumption_validation_error(injection, evidence)
                if validation_error is not None:
                    errors.append(
                        f"{source} returned non-matching runtime parameter consumption evidence: "
                        f"{validation_error}"
                    )
                    if invalid_evidence is None:
                        invalid_evidence = evidence
                    continue
            return evidence, errors
    if invalid_evidence is not None:
        return invalid_evidence, errors
    return None, errors


def _collect_http_runtime_parameter_consumption_evidence(
    smoke: Any,
    compose: Sequence[str] | None,
    cfg: Any,
    token: str | None,
    injection: JsonObject | None = None,
) -> JsonObject | None:
    _ = compose
    if token is None:
        return None
    for params in (
        {"path": "rlRuntimePolicyParameters", "shard": cfg.shard},
        {"path": "rlRuntimePolicyParameters"},
        {"shard": cfg.shard},
        {},
    ):
        try:
            result = smoke.http_json(
                "GET",
                cfg.server_url,
                "/api/user/memory",
                headers=smoke.token_headers(token),
                params=params,
                timeout=RUN_API_TIMEOUT_SECONDS,
            )
        except Exception:  # noqa: BLE001 - one degraded memory probe must not block remaining shapes
            continue
        if result.status != 200:
            continue
        evidence = find_runtime_parameter_consumption_evidence(result.payload, injection=injection)
        if evidence is not None:
            return evidence
    return None


def _collect_redis_runtime_parameter_consumption_evidence(
    smoke: Any,
    compose: Sequence[str] | None,
    cfg: Any,
    token: str | None,
    injection: JsonObject | None = None,
) -> JsonObject | None:
    _ = token
    if compose is None:
        return None
    eval_script = """
local expectedUsername = tostring(ARGV[1] or "")
local cursor = "0"
local candidates = {}
local seen = {}
local candidateLimit = 32
local candidateMaxDepth = 6
local nestedRuntimePolicyParameterKeys = {
  "__SCREEPS_RL_RUNTIME_POLICY_PARAMETER_CONSUMPTION__",
  "runtimeParameterConsumption",
  "runtimePolicyParameterConsumption",
  "data",
  "memory",
  "Memory",
  "value",
  "evidence",
}
local function decodedRuntimePolicyParameterValue(value)
  if type(value) == "table" then
    return value
  end
  if type(value) ~= "string" then
    return nil
  end
  local ok, decoded = pcall(cjson.decode, value)
  if ok and type(decoded) == "table" then
    return decoded
  end
  return nil
end
local function nonEmptyString(value)
  if type(value) == "string" and value ~= "" then
    return value
  end
  return nil
end
local function scalarOwnerUsername(value)
  local text = nonEmptyString(value)
  if text == nil then
    return nil
  end
  if string.len(text) == 24 and string.match(text, "^[0-9a-fA-F]+$") then
    return nil
  end
  return text
end
local function nestedOwnerUsername(value)
  if type(value) ~= "table" then
    return nil
  end
  return nonEmptyString(value.username)
    or nonEmptyString(value.ownerUsername)
    or nonEmptyString(value.owner_username)
    or nonEmptyString(value.userName)
    or nonEmptyString(value.user_name)
    or nonEmptyString(value.name)
end
local function explicitOwnerUsername(value)
  if type(value) ~= "table" then
    return nil
  end
  return nonEmptyString(value.username)
    or nonEmptyString(value.ownerUsername)
    or nonEmptyString(value.owner_username)
    or nonEmptyString(value.userName)
    or nonEmptyString(value.user_name)
    or nestedOwnerUsername(value.owner)
    or nestedOwnerUsername(value.user)
    or scalarOwnerUsername(value.owner)
end
local function hasDifferentExplicitOwner(value)
  if expectedUsername == "" or type(value) ~= "table" then
    return false
  end
  local observed = explicitOwnerUsername(value)
  return observed ~= nil and observed ~= expectedUsername
end
local function appendRuntimePolicyParameterCandidate(source, value)
  if #candidates >= candidateLimit then
    return
  end
  if hasDifferentExplicitOwner(value) then
    return
  end
  table.insert(candidates, {source = source, value = value})
end
local function pushRuntimePolicyParameterEvidence(source, value, depth)
  if depth > candidateMaxDepth or #candidates >= candidateLimit then
    return
  end
  local decoded = decodedRuntimePolicyParameterValue(value)
  if decoded == nil then
    return
  end
  if hasDifferentExplicitOwner(decoded) then
    return
  end
  if decoded.type == "screeps-rl-runtime-policy-parameter-consumption" then
    appendRuntimePolicyParameterCandidate(source, decoded)
    return
  end
  local runtimePolicyParameters = decodedRuntimePolicyParameterValue(decoded.rlRuntimePolicyParameters)
  if runtimePolicyParameters ~= nil then
    appendRuntimePolicyParameterCandidate(source .. ".rlRuntimePolicyParameters", runtimePolicyParameters)
  end
  for _, key in ipairs(nestedRuntimePolicyParameterKeys) do
    if decoded[key] ~= nil then
      pushRuntimePolicyParameterEvidence(source .. "." .. key, decoded[key], depth + 1)
    end
  end
  local nestedCandidates = decoded.candidates
  if type(nestedCandidates) == "table" then
    for index, item in ipairs(nestedCandidates) do
      pushRuntimePolicyParameterEvidence(source .. ".candidates[" .. tostring(index) .. "]", item, depth + 1)
      if #candidates >= candidateLimit then
        return
      end
    end
  end
  if decoded[1] ~= nil then
    for index, item in ipairs(decoded) do
      pushRuntimePolicyParameterEvidence(source .. "[" .. tostring(index) .. "]", item, depth + 1)
      if #candidates >= candidateLimit then
        return
      end
    end
  end
end
local function pushRuntimePolicyParameterCandidate(source, value)
  pushRuntimePolicyParameterEvidence(source, value, 0)
end
for _, pattern in ipairs({"*memory*", "*Memory*"}) do
  cursor = "0"
  repeat
    local result = redis.call("SCAN", cursor, "MATCH", pattern, "COUNT", 100)
    cursor = result[1]
    for _, key in ipairs(result[2]) do
      local keyText = tostring(key)
      local keyLower = string.lower(keyText)
      if not seen[keyText] and string.find(keyLower, "memory", 1, true) then
        seen[keyText] = true
        local keyType = redis.call("TYPE", key).ok
        if keyType == "string" then
          local value = redis.call("GET", key)
          pushRuntimePolicyParameterCandidate("redis." .. keyText, value)
        end
      end
    end
  until cursor == "0"
end
return cjson.encode({ok = true, candidates = candidates})
""".strip()
    username = text_or_none(getattr(cfg, "username", None)) or ""
    command = [*compose, "exec", "-T", "redis", "redis-cli", "--raw", "EVAL", eval_script, "0", username]
    result = smoke.run_command(command, cfg, timeout=60, output_limit=200000)
    if result.get("returncode") != 0:
        return None
    try:
        payload = _json_payload_from_command_output(result.get("output_excerpt", ""))
    except (IndexError, json.JSONDecodeError):
        return None
    return find_runtime_parameter_consumption_evidence(
        payload,
        injection=injection,
        owner_username=username,
    )


def _collect_mongo_runtime_parameter_consumption_evidence(
    smoke: Any,
    compose: Sequence[str] | None,
    cfg: Any,
    token: str | None,
    injection: JsonObject | None = None,
) -> JsonObject | None:
    _ = token
    if compose is None:
        return None
    eval_script = f"""
const smokeDb = db.getSiblingDB({json.dumps(cfg.mongo_db)});
const user = smokeDb.getCollection('users').findOne({{username: {json.dumps(cfg.username)}}});
const candidates = [];
const pushCandidate = (source, value) => {{
  if (value === undefined || value === null) return;
  candidates.push({{source, value}});
}};
const parseJson = value => {{
  if (typeof value !== 'string') return value;
  try {{ return JSON.parse(value); }} catch (err) {{ return value; }}
}};
const pushRuntimePolicyParameterCandidate = (source, value) => {{
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== 'object') return;
  if (parsed.type === {json.dumps(RUNTIME_PARAMETER_CONSUMPTION_TYPE)}) {{
    pushCandidate(source, parsed);
  }}
  if (parsed.rlRuntimePolicyParameters !== undefined) {{
    pushCandidate(source + '.rlRuntimePolicyParameters', parsed.rlRuntimePolicyParameters);
  }}
}};
if (user) {{
  pushRuntimePolicyParameterCandidate('users.memory', user.memory);
  pushRuntimePolicyParameterCandidate('users.Memory', user.Memory);
  for (const collectionName of ['users.memory', 'user.memory', 'memory']) {{
    try {{
      const record = smokeDb.getCollection(collectionName).findOne({{
        $or: [{{user: user._id}}, {{user: String(user._id)}}, {{username: user.username}}]
      }}, {{rlRuntimePolicyParameters: 1, memory: 1, data: 1}});
      if (record) {{
        pushRuntimePolicyParameterCandidate(collectionName + '.rlRuntimePolicyParameters', record.rlRuntimePolicyParameters);
        pushRuntimePolicyParameterCandidate(collectionName + '.memory', record.memory);
        pushRuntimePolicyParameterCandidate(collectionName + '.data', record.data);
      }}
    }} catch (err) {{}}
  }}
}}
print(JSON.stringify({{ok: true, candidates}}));
"""
    command = [*compose, "exec", "-T", "mongo", "mongosh", "--quiet", "--eval", eval_script]
    result = smoke.run_command(command, cfg, timeout=60, output_limit=200000)
    if result.get("returncode") != 0:
        return None
    try:
        payload = _json_payload_from_command_output(result.get("output_excerpt", ""))
    except (IndexError, json.JSONDecodeError):
        return None
    return find_runtime_parameter_consumption_evidence(payload, injection=injection)


def _json_payload_from_command_output(output: Any) -> Any:
    return json.loads(str(output).strip().splitlines()[-1])


def find_runtime_parameter_consumption_evidence(
    payload: Any,
    *,
    injection: JsonObject | None = None,
    owner_username: str | None = None,
) -> JsonObject | None:
    fallback: JsonObject | None = None
    for candidate in iter_runtime_parameter_consumption_candidates(payload, owner_username=owner_username):
        if (
            isinstance(candidate, dict)
            and candidate.get("type") == RUNTIME_PARAMETER_CONSUMPTION_TYPE
            and candidate.get("consumerMarker") == RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER
        ):
            copied = copy.deepcopy(candidate)
            if (
                injection is not None
                and runtime_parameter_consumption_validation_error(injection, copied) is None
            ):
                return copied
            if fallback is None:
                fallback = copied
    return fallback


def iter_runtime_parameter_consumption_candidates(
    payload: Any,
    depth: int = 0,
    *,
    owner_username: str | None = None,
) -> Iterable[Any]:
    if depth > 4:
        return
    decoded = decode_runtime_parameter_jsonish(payload)
    if decoded is not payload:
        yield from iter_runtime_parameter_consumption_candidates(
            decoded,
            depth + 1,
            owner_username=owner_username,
        )
    if isinstance(payload, dict):
        if not runtime_parameter_record_matches_username(payload, owner_username):
            return
        yield payload
        for key in (
            RUNTIME_PARAMETER_CONSUMPTION_GLOBAL,
            "rlRuntimePolicyParameters",
            "runtimeParameterConsumption",
            "runtimePolicyParameterConsumption",
            "data",
            "memory",
            "Memory",
            "value",
            "evidence",
        ):
            if key in payload:
                yield from iter_runtime_parameter_consumption_candidates(
                    payload[key],
                    depth + 1,
                    owner_username=owner_username,
                )
        candidates = payload.get("candidates")
        if isinstance(candidates, list):
            for item in candidates:
                yield from iter_runtime_parameter_consumption_candidates(
                    item,
                    depth + 1,
                    owner_username=owner_username,
                )
    elif isinstance(payload, list):
        for item in payload:
            yield from iter_runtime_parameter_consumption_candidates(
                item,
                depth + 1,
                owner_username=owner_username,
            )


def decode_runtime_parameter_jsonish(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    stripped = value.strip()
    if not stripped or stripped[0] not in "[{\"":
        return value
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return value


def mark_runtime_parameter_injection_failed(injection: JsonObject, error: Any) -> JsonObject:
    updated = copy.deepcopy(injection)
    if updated.get("status") == "prepared":
        updated["status"] = "failed"
        updated["runtimeParameterInjection"] = False
        updated["inlineCandidatesRuntimeInjected"] = False
        updated["reason"] = f"code upload did not complete: {_safe_text(error, 240)}"
    return updated


def mark_runtime_parameter_injection_not_attempted(injection: JsonObject, error: Any) -> JsonObject:
    updated = copy.deepcopy(injection)
    if updated.get("candidateParameterScope") == "runtime_injected":
        updated["status"] = "not_attempted"
        updated["runtimeParameterInjection"] = False
        updated["inlineCandidatesRuntimeInjected"] = False
        updated["reason"] = (
            "simulator run failed before runtime parameter upload was attempted: "
            f"{_safe_text(error, 240)}"
        )
    updated.setdefault("runtimeParameterInjection", False)
    updated.setdefault("inlineCandidatesRuntimeInjected", False)
    updated.setdefault("candidateParameterScope", "metadata_only")
    updated.setdefault("parametersSha256", None)
    updated.setdefault("reason", "runtime parameter upload was not attempted")
    consumption = runtime_parameter_consumption_check(updated, None)
    updated = apply_runtime_parameter_consumption_to_injection(updated, consumption)
    updated.setdefault("runtimeParameterConsumption", False)
    updated.setdefault("runtimeParameterConsumptionStatus", consumption.get("status", "not_attempted"))
    return updated


def _safe_compose_project_name(value: str) -> str:
    """Return a Docker Compose-compatible project name.

    Docker Compose rejects COMPOSE_PROJECT_NAME values containing uppercase
    letters or dots. Run IDs commonly include UTC timestamps such as
    ``20260512T183509Z``; if that token reaches COMPOSE_PROJECT_NAME unchanged,
    ``docker compose up`` exits immediately and the harness later waits for HTTP
    until timeout. Keep the artifact/run directory name untouched, but normalize
    the Compose project name used for Docker resources.
    """
    safe = _safe_filename(value).lower().replace(".", "-")
    safe = re.sub(r"[^a-z0-9_-]", "-", safe)
    safe = re.sub(r"-+", "-", safe).strip("-_")
    if not safe or not re.match(r"^[a-z0-9]", safe):
        safe = f"rl-sim-{safe}".strip("-_")
    return safe or "rl-sim-worker"


def _env_flag_enabled(name: str) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return False
    return raw.lower() in {"1", "true", "yes", "on"}


def _effective_run_worker_count(workers: int, variants: Sequence[str]) -> int:
    if workers <= 0:
        return 0
    if not variants:
        return workers
    return max(1, min(workers, len(variants)))


def _run_worker_project_prefix(run_id: str) -> str:
    sentinel_worker_suffix = "-00"
    sentinel_project = _safe_compose_project_name(
        f"{RUN_WORKER_PREFIX}-{_safe_filename(run_id)}{sentinel_worker_suffix}"
    )
    if sentinel_project.endswith(sentinel_worker_suffix):
        return sentinel_project[: -len(sentinel_worker_suffix)]
    return sentinel_project


def _matching_run_worker_container_names(
    run_id: str,
    container_names: Sequence[str],
    *,
    worker_index: int | None = None,
) -> list[str]:
    """Return only Docker container names owned by this simulator run id."""
    prefix = f"{_run_worker_project_prefix(run_id)}-"
    if worker_index is None:
        worker_container_pattern = re.compile(rf"^{re.escape(prefix)}\d{{2,}}-")
    else:
        if worker_index < 0:
            return []
        worker_container_pattern = re.compile(rf"^{re.escape(prefix)}{worker_index:02d}-")
    matches = []
    for raw_name in container_names:
        name = raw_name.lstrip("/")
        if worker_container_pattern.match(name):
            matches.append(name)
    return sorted(set(matches))


def validate_run_id_token(value: str) -> str:
    if (
        not value
        or value in {".", ".."}
        or ".." in value
        or "/" in value
        or "\\" in value
        or not RUN_ID_TOKEN_RE.fullmatch(value)
    ):
        raise ValueError("run_id must use only letters, numbers, dashes, and underscores with no path separators or '..'")
    return value


def parse_run_id_token(value: str) -> str:
    try:
        return validate_run_id_token(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def normalize_private_server_code_branch(branch: str) -> str:
    """Normalize user-facing active branch names for private-server /api/user/code."""
    aliases = {
        "activeWorld": "$activeWorld",
        "activeSim": "$activeSim",
    }
    return aliases.get(branch, branch)


def _coerce_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _read_linux_memory_mib(meminfo_path: Path = Path("/proc/meminfo")) -> JsonObject:
    """Read stable memory fields from Linux /proc/meminfo in MiB."""
    try:
        text = meminfo_path.read_text(encoding="utf-8")
    except OSError as exc:
        return {"error": _safe_text(exc, 240)}
    values: dict[str, int] = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        key = parts[0].rstrip(":")
        try:
            kib = int(parts[1])
        except ValueError:
            continue
        values[key] = kib // 1024
    return {
        "memoryTotalMiB": values.get("MemTotal"),
        "memoryAvailableMiB": values.get("MemAvailable", values.get("MemFree")),
        "swapFreeMiB": values.get("SwapFree", 0),
    }


def _docker_binary_for_guard() -> str | None:
    return shutil.which("docker")


def _docker_container_names(
    *,
    all_containers: bool,
    docker_binary: str | None = None,
    timeout: int = 12,
) -> tuple[list[str], str | None]:
    docker = docker_binary or _docker_binary_for_guard()
    if not docker:
        return [], "docker command not found"
    command = [docker, "ps"]
    if all_containers:
        command.append("-a")
    command.extend(["--format", "{{.Names}}"])
    try:
        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return [], _safe_text(exc, 240)
    if result.returncode != 0:
        error_text = result.stderr.strip() or result.stdout.strip() or f"docker ps exited {result.returncode}"
        return [], _safe_text(error_text, 240)
    return sorted({line.strip().lstrip("/") for line in result.stdout.splitlines() if line.strip()}), None


def _active_simulator_container_groups(container_names: Sequence[str]) -> JsonObject:
    rl_sim = sorted({name for name in container_names if name.startswith(f"{RUN_WORKER_PREFIX}-")})
    private_smoke = sorted({name for name in container_names if name.startswith("screeps-private-smoke-")})
    return {
        "activeDockerContainerCount": len(container_names),
        "activeRlSimulatorContainerCount": len(rl_sim),
        "activePrivateSmokeContainerCount": len(private_smoke),
        "activeSimulatorContainerCount": len(rl_sim) + len(private_smoke),
        "activeRlSimulatorContainers": rl_sim[:25],
        "activePrivateSmokeContainers": private_smoke[:25],
    }


def collect_resource_guard_host_snapshot(
    *,
    active_container_names: Sequence[str] | None = None,
    docker_error: str | None = None,
) -> JsonObject:
    """Collect host resource facts used to decide whether a Docker scale run is safe."""
    memory = _read_linux_memory_mib()
    if active_container_names is None:
        active_container_names, docker_error = _docker_container_names(all_containers=False)
    groups = _active_simulator_container_groups(active_container_names)
    snapshot: JsonObject = {
        **memory,
        "cpuCount": os.cpu_count(),
        "dockerAvailable": docker_error is None,
        "dockerError": docker_error,
        **groups,
    }
    available = _coerce_int(snapshot.get("memoryAvailableMiB"))
    swap = _coerce_int(snapshot.get("swapFreeMiB")) or 0
    snapshot["memoryAndSwapAvailableMiB"] = available + swap if available is not None else None
    return snapshot


def _resource_guard_override_sources(allow_unsafe_scale: bool) -> list[str]:
    sources: list[str] = []
    if allow_unsafe_scale:
        sources.append("cli:--allow-unsafe-scale")
    if _env_flag_enabled(RUN_RESOURCE_GUARD_ALLOW_UNSAFE_ENV):
        sources.append(f"env:{RUN_RESOURCE_GUARD_ALLOW_UNSAFE_ENV}")
    return sources


def _required_resource_guard_memory_mib(worker_count: int, active_simulators: int) -> int:
    return (
        RUN_RESOURCE_GUARD_HOST_RESERVE_MIB
        + (max(0, worker_count) * RUN_RESOURCE_GUARD_MEMORY_PER_WORKER_MIB)
        + (max(0, active_simulators) * RUN_RESOURCE_GUARD_ACTIVE_STACK_MEMORY_MIB)
    )


def _max_resource_guard_workers_for_memory(available_mib: int | None, active_simulators: int) -> int | None:
    if available_mib is None:
        return None
    worker_budget = available_mib - RUN_RESOURCE_GUARD_HOST_RESERVE_MIB - (
        max(0, active_simulators) * RUN_RESOURCE_GUARD_ACTIVE_STACK_MEMORY_MIB
    )
    if worker_budget < RUN_RESOURCE_GUARD_MEMORY_PER_WORKER_MIB:
        return 0
    return max(0, worker_budget // RUN_RESOURCE_GUARD_MEMORY_PER_WORKER_MIB)


def _memory_gap_mib(required_mib: int, available_mib: int | None) -> int | None:
    if available_mib is None:
        return None
    return max(0, required_mib - available_mib)


def build_scale_validation_plan(
    *,
    run_id: str,
    requested_workers: int,
    effective_workers: int,
    variants: Sequence[str],
    host_snapshot: JsonObject,
    min_concurrent_environments: int = 0,
) -> JsonObject:
    """Build deterministic resource and sizing guidance for an E2 scale proof."""
    active_simulators = _coerce_int(host_snapshot.get("activeSimulatorContainerCount")) or 0
    available_mib = _coerce_int(host_snapshot.get("memoryAndSwapAvailableMiB"))
    target = max(0, min_concurrent_environments)
    target_worker_count = max(target, requested_workers, effective_workers)
    required_now = _required_resource_guard_memory_mib(target_worker_count, active_simulators)
    required_after_cleanup = _required_resource_guard_memory_mib(target_worker_count, 0)
    max_workers_now = _max_resource_guard_workers_for_memory(available_mib, active_simulators)
    max_workers_after_cleanup = _max_resource_guard_workers_for_memory(available_mib, 0)
    min_successful = math.ceil(target * RUN_SCALE_VALIDATION_TARGET_SUCCESS_RATE) if target else None
    target_concurrency_met = True if target == 0 else effective_workers >= target
    docker_available = host_snapshot.get("dockerAvailable") is not False
    active_clean = active_simulators == 0
    memory_ok_now = available_mib is not None and available_mib >= required_now
    memory_ok_after_cleanup = available_mib is not None and available_mib >= required_after_cleanup
    recommendations: list[str] = []
    if target and not target_concurrency_met:
        recommendations.append(
            f"request at least {target} effective simulator environment row(s); "
            f"use --scale-environments {target} when reusing base variants"
        )
    if active_simulators > 0:
        recommendations.append(
            f"stop {active_simulators} active rl-sim/private-smoke Docker container(s) before the scale proof"
        )
    if available_mib is None:
        recommendations.append("rerun on a Linux host/window where memory and swap availability can be read")
    elif not memory_ok_after_cleanup:
        recommendations.append(
            f"prepare at least {required_after_cleanup} MiB memory/swap after cleanup "
            f"(current after-cleanup gap {required_after_cleanup - available_mib} MiB)"
        )
    elif active_simulators > 0:
        recommendations.append("after cleanup, rerun the same scale proof on this host")
    if not docker_available:
        docker_error = _safe_text(host_snapshot.get("dockerError") or "docker unavailable", 240)
        recommendations.append(f"restore Docker availability before running the proof: {docker_error}")

    return {
        "type": RUN_SCALE_VALIDATION_PLAN_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "runId": run_id,
        "requestedWorkers": requested_workers,
        "effectiveWorkers": effective_workers,
        "variantCount": len(variants),
        "minConcurrentEnvironments": target,
        "targetWorkerCountForEstimate": target_worker_count,
        "targetConcurrencyMet": target_concurrency_met,
        "successCriteria": {
            "minimumSuccessRate": RUN_SCALE_VALIDATION_TARGET_SUCCESS_RATE if target else None,
            "minimumSuccessfulEnvironments": min_successful,
            "minimumRequestedTicksPerEnvironment": 1 if target else None,
            "brokenPipeAllowed": False,
        },
        "capacity": {
            "currentMaxWorkers": max_workers_now,
            "afterCleanupMaxWorkers": max_workers_after_cleanup,
            "memoryEligibleNow": memory_ok_now,
            "memoryEligibleAfterCleanup": memory_ok_after_cleanup,
            "canProveTargetNow": bool(target_concurrency_met and active_clean and memory_ok_now and docker_available),
            "canProveTargetAfterCleanup": bool(target_concurrency_met and memory_ok_after_cleanup and docker_available),
        },
        "memory": {
            "availableMiB": available_mib,
            "requiredNowMiB": required_now,
            "requiredAfterCleanupMiB": required_after_cleanup,
            "additionalNowMiB": _memory_gap_mib(required_now, available_mib),
            "additionalAfterCleanupMiB": _memory_gap_mib(required_after_cleanup, available_mib),
            "estimatedCleanupReliefMiB": active_simulators * RUN_RESOURCE_GUARD_ACTIVE_STACK_MEMORY_MIB,
            "hostReserveMiB": RUN_RESOURCE_GUARD_HOST_RESERVE_MIB,
            "memoryPerWorkerMiB": RUN_RESOURCE_GUARD_MEMORY_PER_WORKER_MIB,
            "activeStackMemoryMiB": RUN_RESOURCE_GUARD_ACTIVE_STACK_MEMORY_MIB,
        },
        "cleanup": {
            "activeSimulatorContainerCount": active_simulators,
            "activeRlSimulatorContainerCount": _coerce_int(host_snapshot.get("activeRlSimulatorContainerCount")) or 0,
            "activePrivateSmokeContainerCount": _coerce_int(host_snapshot.get("activePrivateSmokeContainerCount")) or 0,
            "activeRlSimulatorContainers": [
                _safe_text(name, 160) for name in host_snapshot.get("activeRlSimulatorContainers", [])[:25]
            ]
            if isinstance(host_snapshot.get("activeRlSimulatorContainers"), list)
            else [],
            "activePrivateSmokeContainers": [
                _safe_text(name, 160) for name in host_snapshot.get("activePrivateSmokeContainers", [])[:25]
            ]
            if isinstance(host_snapshot.get("activePrivateSmokeContainers"), list)
            else [],
        },
        "recommendations": recommendations,
    }


def build_resource_guard_decision(
    *,
    run_id: str,
    workers: int,
    variants: Sequence[str],
    allow_unsafe_scale: bool = False,
    host_snapshot: JsonObject | None = None,
    min_concurrent_environments: int = 0,
) -> JsonObject:
    """Return a redacted, deterministic resource-guard decision for a run request."""
    effective_workers = _effective_run_worker_count(workers, variants)
    snapshot = host_snapshot or collect_resource_guard_host_snapshot()
    active_simulators = _coerce_int(snapshot.get("activeSimulatorContainerCount")) or 0
    available_mib = _coerce_int(snapshot.get("memoryAndSwapAvailableMiB"))
    cpu_count = _coerce_int(snapshot.get("cpuCount"))
    required_min_workers = max(0, min_concurrent_environments)
    scale_run = (
        workers >= RUN_RESOURCE_GUARD_MIN_WORKERS
        or effective_workers >= RUN_RESOURCE_GUARD_MIN_WORKERS
        or required_min_workers >= RUN_RESOURCE_GUARD_MIN_WORKERS
    )
    guarded_workers = max(workers, effective_workers, required_min_workers)
    required_memory_mib = _required_resource_guard_memory_mib(guarded_workers, active_simulators)
    native_build_jobs = guarded_workers * RUN_RESOURCE_GUARD_NATIVE_BUILD_JOBS_PER_WORKER
    historical_jobs = guarded_workers * RUN_RESOURCE_GUARD_HISTORICAL_NODE_GYP_JOBS_PER_WORKER
    scale_validation = build_scale_validation_plan(
        run_id=run_id,
        requested_workers=workers,
        effective_workers=effective_workers,
        variants=variants,
        host_snapshot=snapshot,
        min_concurrent_environments=required_min_workers,
    )
    reasons: list[str] = []
    warnings: list[str] = []
    if scale_run:
        if required_min_workers > 0 and effective_workers < required_min_workers:
            reasons.append(
                f"effectiveWorkers={effective_workers} does not satisfy "
                f"minConcurrentEnvironments={required_min_workers}"
            )
        if available_mib is None:
            reasons.append("host memory/swap availability could not be read")
        elif available_mib < required_memory_mib:
            reasons.append(
                f"workers={workers} effectiveWorkers={effective_workers} requires "
                f"{required_memory_mib} MiB memory/swap; host reports {available_mib} MiB"
            )
        if snapshot.get("dockerAvailable") is False:
            docker_error = _safe_text(snapshot.get("dockerError") or "docker unavailable", 240)
            reasons.append(f"active Docker stack check failed: {docker_error}")
        if active_simulators > 0:
            reasons.append(f"{active_simulators} active rl-sim/private-smoke Docker container(s) already running")
        if cpu_count is None:
            warnings.append("host CPU count could not be read")
        elif native_build_jobs > max(cpu_count, 1):
            warnings.append(
                f"native build jobs={native_build_jobs} can oversubscribe cpuCount={cpu_count}; "
                "run only when memory headroom is confirmed"
            )
    override_sources = _resource_guard_override_sources(allow_unsafe_scale)
    rejected = bool(reasons)
    ok = not rejected or bool(override_sources)
    decision = "allowed"
    if rejected and override_sources:
        decision = "allowed-with-override"
    elif rejected:
        decision = "rejected"
    return {
        "type": "screeps-rl-simulator-resource-guard",
        "schemaVersion": SCHEMA_VERSION,
        "ok": ok,
        "decision": decision,
        "runId": run_id,
        "requestedWorkers": workers,
        "effectiveWorkers": effective_workers,
        "guardedWorkerEstimate": guarded_workers,
        "variantCount": len(variants),
        "scaleRun": scale_run,
        "scaleWorkerThreshold": RUN_RESOURCE_GUARD_MIN_WORKERS,
        "reasons": reasons,
        "warnings": warnings,
        "override": {
            "enabled": bool(override_sources),
            "sources": override_sources,
        },
        "host": {
            "memoryTotalMiB": _coerce_int(snapshot.get("memoryTotalMiB")),
            "memoryAvailableMiB": _coerce_int(snapshot.get("memoryAvailableMiB")),
            "swapFreeMiB": _coerce_int(snapshot.get("swapFreeMiB")) or 0,
            "memoryAndSwapAvailableMiB": available_mib,
            "cpuCount": cpu_count,
            "dockerAvailable": bool(snapshot.get("dockerAvailable")),
            "dockerError": _safe_text(snapshot.get("dockerError"), 240) if snapshot.get("dockerError") else None,
            "activeDockerContainerCount": _coerce_int(snapshot.get("activeDockerContainerCount")) or 0,
            "activeRlSimulatorContainerCount": _coerce_int(snapshot.get("activeRlSimulatorContainerCount")) or 0,
            "activePrivateSmokeContainerCount": _coerce_int(snapshot.get("activePrivateSmokeContainerCount")) or 0,
            "activeSimulatorContainerCount": active_simulators,
            "activeRlSimulatorContainers": [
                _safe_text(name, 160) for name in snapshot.get("activeRlSimulatorContainers", [])[:25]
            ]
            if isinstance(snapshot.get("activeRlSimulatorContainers"), list)
            else [],
            "activePrivateSmokeContainers": [
                _safe_text(name, 160) for name in snapshot.get("activePrivateSmokeContainers", [])[:25]
            ]
            if isinstance(snapshot.get("activePrivateSmokeContainers"), list)
            else [],
        },
        "estimate": {
            "hostReserveMiB": RUN_RESOURCE_GUARD_HOST_RESERVE_MIB,
            "memoryPerWorkerMiB": RUN_RESOURCE_GUARD_MEMORY_PER_WORKER_MIB,
            "activeStackMemoryMiB": RUN_RESOURCE_GUARD_ACTIVE_STACK_MEMORY_MIB,
            "requiredMemoryAndSwapMiB": required_memory_mib,
            "nativeBuildJobsPerWorker": RUN_RESOURCE_GUARD_NATIVE_BUILD_JOBS_PER_WORKER,
            "nativeBuildParallelJobs": native_build_jobs,
            "historicalNodeGypJobsPerWorker": RUN_RESOURCE_GUARD_HISTORICAL_NODE_GYP_JOBS_PER_WORKER,
            "historicalUnboundedNativeBuildParallelJobs": historical_jobs,
            "nativeBuildPolicy": (
                "generated worker Compose sets npm_config_jobs/NPM_CONFIG_JOBS/JOBS/MAKEFLAGS to 1 "
                "so first-run isolated-vm compilation is bounded per worker"
            ),
        },
        "scaleValidation": scale_validation,
    }


def _build_run_ports(worker_index: int, host_port_start: int = RUN_HTTP_START) -> tuple[int, int]:
    http_port = host_port_start + (worker_index * RUN_HTTP_PORT_STEP)
    cli_port = http_port + 1
    if http_port > 65535:
        raise RuntimeError(f"worker HTTP port out of range: {http_port}")
    if cli_port > 65535:
        raise RuntimeError(f"worker CLI port out of range: {cli_port}")
    if http_port == cli_port:
        raise RuntimeError(f"worker HTTP and CLI ports must differ: {http_port}")
    return http_port, cli_port


def _host_port_unavailable_reason(smoke: Any, host: str, port: int) -> str | None:
    probe = getattr(smoke, "host_port_unavailable_reason", None)
    if not callable(probe):
        return None
    reason = probe(host, port)
    return _safe_text(reason, 200) if reason else None


def _select_run_ports(
    smoke: Any,
    server_host: str,
    *,
    worker_index: int,
    worker_count: int,
    host_port_start: int = RUN_HTTP_START,
) -> tuple[int, int]:
    if worker_count <= 0:
        raise RuntimeError("worker count must be a positive integer")

    last_failure = ""
    for attempt in range(RUN_PORT_SCAN_ATTEMPTS):
        candidate_worker_index = worker_index + (attempt * worker_count)
        try:
            http_port, cli_port = _build_run_ports(candidate_worker_index, host_port_start)
        except RuntimeError as exc:
            last_failure = _safe_text(exc, 200)
            break

        unavailable = []
        for service, port in (("http", http_port), ("cli", cli_port)):
            reason = _host_port_unavailable_reason(smoke, server_host, port)
            if reason:
                unavailable.append(f"{service} {server_host}:{port} ({reason})")
        if not unavailable:
            return http_port, cli_port
        last_failure = "; ".join(unavailable)

    suffix = f": {last_failure}" if last_failure else ""
    raise RuntimeError(
        f"no available simulator host port pair for worker {worker_index} "
        f"after scanning {RUN_PORT_SCAN_ATTEMPTS} candidates{suffix}"
    )


def _extract_int(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _extract_room_payload(data: Any, room: str) -> dict[str, Any]:
    if not isinstance(data, dict):
        return {}
    if data.get("room") == room and isinstance(data.get("details"), dict):
        nested = data["details"]
        return nested if isinstance(nested, dict) else {}
    if data.get("roomName") == room and isinstance(data.get("room"), dict):
        nested = data["room"]
        return nested if isinstance(nested, dict) else {}
    if data.get("room") == room and isinstance(data.get("roomData"), dict):
        return data["roomData"]
    if data.get("room") == room and isinstance(data.get("data"), dict):
        return data["data"]
    direct = data.get(room)
    return direct if isinstance(direct, dict) else data


def _payload_objects(payload: dict[str, Any] | list[Any]) -> list[JsonObject]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("objects", "roomObjects", "room_objects"):
        objects = payload.get(key)
        if isinstance(objects, list):
            return [item for item in objects if isinstance(item, dict)]
        if isinstance(objects, dict):
            result: list[JsonObject] = []
            for object_id, item in objects.items():
                if not isinstance(item, dict):
                    continue
                normalized = dict(item)
                normalized.setdefault("_id", object_id)
                result.append(normalized)
            return result
    objects = payload.get("objects")
    if isinstance(objects, list):
        return [item for item in objects if isinstance(item, dict)]
    return []


def _owner_text(value: Any) -> str | None:
    if isinstance(value, str) and value:
        return value
    if isinstance(value, dict):
        username = value.get("username")
        if isinstance(username, str) and username:
            return username
        user_id = value.get("id")
        if isinstance(user_id, str) and user_id:
            return user_id
    return None


def _object_owner_text(item: JsonObject) -> str | None:
    return _owner_text(item.get("owner")) or text_or_none(item.get("username")) or text_or_none(item.get("user"))


def _object_user_id(item: JsonObject) -> str | None:
    value = item.get("user")
    if isinstance(value, str) and value:
        return value
    if value is not None:
        return str(value)
    return None


def _room_owner_id(payload: dict[str, Any]) -> str | None:
    user = payload.get("user")
    if isinstance(user, dict):
        user_id = user.get("id") or user.get("_id")
        if isinstance(user_id, str) and user_id:
            return user_id
    for key in ("ownerId", "owner_id", "userId", "user_id"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _room_owner_username(payload: dict[str, Any]) -> str | None:
    user = payload.get("user")
    if isinstance(user, dict):
        username = user.get("username")
        if isinstance(username, str) and username:
            return username
    return None


def _object_is_hostile(
    item: JsonObject,
    owner_id: str | None = None,
    owner_username: str | None = None,
) -> bool:
    if item.get("my") is False or item.get("hostile") is True or item.get("enemy") is True:
        return True
    item_owner_id = _object_user_id(item)
    if owner_id and item_owner_id and item_owner_id != owner_id:
        return True
    item_owner = _owner_text(item.get("owner"))
    return bool(owner_username and item_owner and item_owner != owner_username)


def _object_is_owned(
    item: JsonObject,
    owner_id: str | None = None,
    owner_username: str | None = None,
) -> bool:
    if item.get("my") is True:
        return True
    if _object_is_hostile(item, owner_id, owner_username):
        return False
    item_owner_id = _object_user_id(item)
    if owner_id and item_owner_id == owner_id:
        return True
    item_owner = _owner_text(item.get("owner"))
    if owner_username and item_owner == owner_username:
        return True
    return False


def _object_type(item: JsonObject) -> str | None:
    object_type = item.get("type")
    return object_type if isinstance(object_type, str) and object_type else None


def _structure_type_for_counts(item: JsonObject) -> str | None:
    object_type = _object_type(item)
    if not object_type or object_type in NON_STRUCTURE_OBJECT_TYPES:
        return None
    if object_type == "constructionSite":
        structure_type = item.get("structureType")
        return f"constructionSite:{structure_type}" if isinstance(structure_type, str) and structure_type else object_type
    return object_type


def _collect_structure_counts(
    payload: dict[str, Any] | list[Any],
    *,
    owner_id: str | None = None,
    owner_username: str | None = None,
    owned_only: bool = False,
) -> dict[str, int]:
    explicit_counts: dict[str, int] = {}
    if isinstance(payload, dict):
        explicit_keys = (
            ("ownStructureCounts",)
            if owned_only
            else ("ownStructureCounts", "structureCounts", "structures", "structuresByType", "objectsByType")
        )
        for key in explicit_keys:
            section = payload.get(key)
            if isinstance(section, dict):
                for kind, value in section.items():
                    if isinstance(value, list):
                        explicit_counts[str(kind)] = len(value)
                    else:
                        parsed = _extract_int(value)
                        if parsed is not None:
                            explicit_counts[str(kind)] = parsed
        if not owned_only:
            for key in ("constructionSites", "construction_sites"):
                sites = payload.get(key)
                if isinstance(sites, list):
                    explicit_counts["constructionSite"] = len(sites)

    object_counts: dict[str, int] = {}
    for item in _payload_objects(payload):
        if owned_only and not _object_is_owned(item, owner_id, owner_username):
            continue
        structure_type = _structure_type_for_counts(item)
        if structure_type:
            object_counts[structure_type] = object_counts.get(structure_type, 0) + 1
    counts = dict(explicit_counts)
    for key, value in object_counts.items():
        counts[key] = max(counts.get(key, 0), value)
    return counts


def _parse_memory(value: Any) -> JsonObject:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip().startswith("{"):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _creep_role(item: JsonObject) -> str:
    for candidate in (
        item.get("role"),
        _parse_memory(item.get("memory")).get("role"),
    ):
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    name = item.get("name")
    if isinstance(name, str) and "-" in name:
        prefix = name.split("-", 1)[0].strip()
        if prefix:
            return prefix
    return "unknown"


def _collect_creep_counts(
    payload: dict[str, Any] | list[Any],
    *,
    owner_id: str | None = None,
    owner_username: str | None = None,
    owned_only: bool = False,
) -> tuple[int, dict[str, int]]:
    total = 0
    roles: dict[str, int] = {}
    objects = _payload_objects(payload)
    for item in objects:
        if _object_type(item) != "creep":
            continue
        if owned_only and not _object_is_owned(item, owner_id, owner_username):
            continue
        total += 1
        role = _creep_role(item)
        roles[role] = roles.get(role, 0) + 1

    if isinstance(payload, dict):
        explicit = _extract_int(
            payload.get("ownedCreeps")
            if owned_only
            else payload.get("creeps")
        )
        if explicit is None and owned_only:
            explicit = _extract_int(payload.get("ownedCreepCount"))
        if explicit is not None and explicit > total:
            total = explicit
        role_keys = ("ownCreepRoles", "ownedCreepRoles") if owned_only else ("creepCounts", "creepRoles", "roles")
        for key in role_keys:
            section = payload.get(key)
            if isinstance(section, dict):
                for role, value in section.items():
                    parsed = _extract_int(value)
                    if parsed is not None:
                        roles[str(role)] = parsed
                if not total:
                    total = sum(roles.values())
                break
    return total, dict(sorted(roles.items()))


def _store_value(item: JsonObject, resource: str = "energy") -> int:
    store = item.get("store")
    if isinstance(store, dict):
        parsed = _extract_int(store.get(resource))
        if parsed is not None:
            return max(0, parsed)
    carry = item.get("carry")
    if isinstance(carry, dict):
        parsed = _extract_int(carry.get(resource))
        if parsed is not None:
            return max(0, parsed)
    parsed = _extract_int(item.get(resource))
    return max(0, parsed) if parsed is not None else 0


def _store_capacity(item: JsonObject) -> int:
    store = item.get("store")
    if isinstance(store, dict):
        for key in ("energyCapacity", "storeCapacity", "capacity"):
            parsed = _extract_int(store.get(key))
            if parsed is not None:
                return max(0, parsed)
    for key in ("energyCapacity", "storeCapacity", "capacity"):
        parsed = _extract_int(item.get(key))
        if parsed is not None:
            return max(0, parsed)
    return ROOM_ENERGY_CAPACITY_FALLBACKS.get(str(item.get("type")), 0)


def _sum_owned_stored_energy(
    payload: dict[str, Any],
    *,
    owner_id: str | None = None,
    owner_username: str | None = None,
) -> int:
    explicit = _extract_int(payload.get("storedEnergy"))
    if explicit is not None:
        return max(0, explicit)
    resources = payload.get("resources")
    if isinstance(resources, dict):
        explicit = _extract_int(resources.get("storedEnergy"))
        if explicit is not None:
            return max(0, explicit)
    total = 0
    for item in _payload_objects(payload):
        if _object_type(item) == "creep":
            continue
        if not isinstance(item.get("store"), dict) and _object_type(item) not in ENERGY_STORAGE_OBJECT_TYPES:
            continue
        if not _object_is_owned(item, owner_id, owner_username):
            continue
        total += _store_value(item)
    return total


def _sum_room_energy_capacity(
    payload: dict[str, Any],
    *,
    owner_id: str | None = None,
    owner_username: str | None = None,
) -> int | None:
    for key in ("energyCapacity", "energyCapacityAvailable"):
        parsed = _extract_int(payload.get(key))
        if parsed is not None:
            return max(0, parsed)
    capacity = 0
    for item in _payload_objects(payload):
        if _object_type(item) not in ROOM_ENERGY_CAPACITY_FALLBACKS:
            continue
        if not _object_is_owned(item, owner_id, owner_username):
            continue
        capacity += _store_capacity(item)
    return capacity or None


def _collect_combat_counts(
    payload: dict[str, Any],
    *,
    owner_id: str | None = None,
    owner_username: str | None = None,
) -> JsonObject:
    counts: JsonObject = {
        "hostileCreeps": 0,
        "hostileStructures": 0,
        "ownCreeps": 0,
        "ownStructures": 0,
    }
    for key in ("hostiles", "hostileCreeps"):
        value = payload.get(key)
        if isinstance(value, list):
            counts["hostileCreeps"] = max(counts["hostileCreeps"], len(value))
        elif isinstance(value, int):
            counts["hostileCreeps"] = max(counts["hostileCreeps"], value)

    for item in _payload_objects(payload):
        object_type = item.get("type")
        if not isinstance(object_type, str):
            continue
        if object_type == "creep":
            if _object_is_hostile(item, owner_id, owner_username):
                counts["hostileCreeps"] += 1
            elif _object_is_owned(item, owner_id, owner_username):
                counts["ownCreeps"] += 1
        elif _structure_type_for_counts(item) is not None:
            if _object_is_hostile(item, owner_id, owner_username):
                counts["hostileStructures"] += 1
            elif _object_is_owned(item, owner_id, owner_username):
                counts["ownStructures"] += 1

    explicit = payload.get("combat")
    if isinstance(explicit, dict):
        for key in ("hostileCreeps", "hostileStructures", "ownCreeps", "ownStructures", "hostileKills", "ownLosses"):
            value = _extract_int(explicit.get(key))
            if value is not None:
                counts[key] = value
    return counts


def _summarize_room_state(payload: dict[str, Any], room: str) -> JsonObject:
    normalized = _extract_room_payload(payload, room)
    objects = _payload_objects(normalized)
    owner_id = _room_owner_id(normalized)
    owner_username = _room_owner_username(normalized)
    controller = normalized.get("controller")
    if not isinstance(controller, dict):
        controller = next((item for item in objects if _object_type(item) == "controller"), None)
    controller_summary: JsonObject = {}
    if isinstance(controller, dict):
        level = _extract_int(controller.get("level"))
        progress = _extract_int(controller.get("progress"))
        progress_total = _extract_int(controller.get("progressTotal"))
        owner = _owner_text(controller.get("owner")) or _object_user_id(controller) or owner_username or owner_id
        controller_summary = {
            "level": level,
            "progress": progress,
            "progressTotal": progress_total,
            "my": (
                controller.get("my")
                if isinstance(controller.get("my"), bool)
                else _object_is_owned(controller, owner_id, owner_username)
            ),
            "owner": owner,
        }
    energy = _extract_int(normalized.get("energy"))
    if energy is None:
        energy = _extract_int(normalized.get("energyAvailable"))
    if energy is None:
        resources = normalized.get("resources")
        if isinstance(resources, dict):
            energy = _extract_int(resources.get("storedEnergy"))
    structure_counts = _collect_structure_counts(normalized)
    own_structure_counts = _collect_structure_counts(
        normalized,
        owner_id=owner_id,
        owner_username=owner_username,
        owned_only=True,
    )
    creeps, creep_roles = _collect_creep_counts(normalized)
    own_creeps, own_creep_roles = _collect_creep_counts(
        normalized,
        owner_id=owner_id,
        owner_username=owner_username,
        owned_only=True,
    )
    stored_energy = _sum_owned_stored_energy(normalized, owner_id=owner_id, owner_username=owner_username)
    energy_capacity = _sum_room_energy_capacity(normalized, owner_id=owner_id, owner_username=owner_username)
    owned = bool(controller_summary.get("my")) or sum(own_structure_counts.values()) > 0 or own_creeps > 0
    resources_summary = normalized.get("resources") if isinstance(normalized.get("resources"), dict) else {}
    resources_summary = {
        **resources_summary,
        "storedEnergy": stored_energy,
        **({"energyAvailable": energy} if energy is not None else {}),
    }
    return {
        "room": room,
        "roomName": room,
        "owned": owned,
        "controller": controller_summary if controller_summary else None,
        "energy": energy,
        "energyAvailable": energy,
        "energyCapacity": energy_capacity,
        "storedEnergy": stored_energy,
        "creeps": creeps,
        "ownedCreeps": own_creeps,
        "creepCounts": creep_roles,
        "ownCreepRoles": own_creep_roles,
        "structures": dict(sorted(structure_counts.items())) if structure_counts else {},
        "structureCounts": dict(sorted(own_structure_counts.items())) if own_structure_counts else {},
        "ownStructureCounts": dict(sorted(own_structure_counts.items())) if own_structure_counts else {},
        "ownStructures": sum(own_structure_counts.values()),
        "resources": resources_summary,
        "combat": _collect_combat_counts(normalized, owner_id=owner_id, owner_username=owner_username),
    }


def _terrain_summary(payload: Any) -> JsonObject:
    if not isinstance(payload, dict):
        return {"bytes": 0}
    terrain_payload = payload.get("terrain")
    terrain_text: str | None = None
    if isinstance(terrain_payload, list):
        first = terrain_payload[0] if terrain_payload else None
        if isinstance(first, dict):
            terrain_text = first.get("terrain")
        elif isinstance(first, str):
            terrain_text = first
    elif isinstance(terrain_payload, str):
        terrain_text = terrain_payload
    if not isinstance(terrain_text, str):
        return {"bytes": 0}
    return {
        "bytes": len(terrain_text),
        "sha256": hashlib.sha256(terrain_text.encode("utf-8")).hexdigest(),
    }


def build_scenario_config(
    run_id: str,
    variant_id: str,
    *,
    room: str,
    shard: str,
    branch: str,
    ticks: int,
    code_path: Path,
    map_source_file: Path,
    code_payload_text: str | None = None,
    runtime_parameter_injection: JsonObject | None = None,
) -> JsonObject:
    """Build a deterministic scenario config contract for one variant run."""
    code_data = code_payload_text.encode("utf-8") if code_payload_text is not None else code_path.read_bytes()
    map_data = map_source_file.read_bytes()
    scenario = {
        "type": "screeps-rl-sim-run-scenario",
        "runId": run_id,
        "variantId": variant_id,
        "activeWorldBranch": branch,
        "room": room,
        "shard": shard,
        "tickPlan": {
            "ticks": ticks,
        },
        "spawn": {
            "name": "Spawn1",
            "x": DEFAULT_SPAWN_X,
            "y": DEFAULT_SPAWN_Y,
        },
        "codeArtifact": {
            "path": str(code_path),
            "bytes": len(code_data),
            "sha256": hashlib.sha256(code_data).hexdigest(),
        },
        "mapArtifact": {
            "sourcePath": str(map_source_file),
            "sha256": hashlib.sha256(map_data).hexdigest(),
            "bytes": len(map_data),
        },
    }
    if code_payload_text is not None:
        scenario["codeArtifact"]["payloadSource"] = "runtime-parameter-injected-upload"
    if runtime_parameter_injection is not None:
        scenario["runtimeParameterInjection"] = copy.deepcopy(runtime_parameter_injection)
    return scenario


def _safe_build_scenario_config(
    run_id: str,
    variant_id: str,
    *,
    room: str,
    shard: str,
    branch: str,
    ticks: int,
    code_path: Path,
    map_source_file: Path,
    code_payload_text: str | None = None,
    runtime_parameter_injection: JsonObject | None = None,
) -> JsonObject:
    try:
        if code_path.is_file() and map_source_file.is_file():
            return build_scenario_config(
                run_id,
                variant_id,
                room=room,
                shard=shard,
                branch=branch,
                ticks=ticks,
                code_path=code_path,
                map_source_file=map_source_file,
                code_payload_text=code_payload_text,
                runtime_parameter_injection=runtime_parameter_injection,
            )
    except OSError as exc:
        scenario = {
            "type": "screeps-rl-sim-run-scenario",
            "runId": run_id,
            "variantId": variant_id,
            "activeWorldBranch": branch,
            "room": room,
            "shard": shard,
            "tickPlan": {"ticks": ticks},
            "error": f"scenario artifact read failed: {_safe_text(exc, 240)}",
        }
        if runtime_parameter_injection is not None:
            scenario["runtimeParameterInjection"] = copy.deepcopy(runtime_parameter_injection)
        return scenario
    scenario = {
        "type": "screeps-rl-sim-run-scenario",
        "runId": run_id,
        "variantId": variant_id,
        "activeWorldBranch": branch,
        "room": room,
        "shard": shard,
        "tickPlan": {"ticks": ticks},
        "codeArtifact": {"path": str(code_path), "available": False},
        "mapArtifact": {"sourcePath": str(map_source_file), "available": False},
    }
    if runtime_parameter_injection is not None:
        scenario["runtimeParameterInjection"] = copy.deepcopy(runtime_parameter_injection)
    return scenario


def runtime_parameter_injection_uploaded_code_text(
    uploaded_code_text: str | None,
    runtime_parameter_injection: JsonObject,
) -> str | None:
    if uploaded_code_text is None:
        return None
    if (
        runtime_parameter_injection.get("status") != "injected"
        or runtime_parameter_injection.get("runtimeParameterInjection") is not True
        or not isinstance(runtime_parameter_injection.get("uploadedCodeSha256"), str)
    ):
        return None
    return uploaded_code_text


def _run_summary_fields(variant_results: Sequence[JsonObject]) -> JsonObject:
    variant_rows = [item for item in variant_results if isinstance(item, dict)]
    successful = sum(1 for item in variant_rows if item.get("ok") is True)
    failed = len(variant_rows) - successful
    total_ticks = sum(_extract_int(item.get("ticks_run")) or 0 for item in variant_rows)
    errors: list[str] = []
    for item in variant_rows:
        if item.get("ok") is True:
            continue
        variant_id = item.get("variant_id") if isinstance(item.get("variant_id"), str) else "unknown"
        error = item.get("error")
        if isinstance(error, str) and error:
            errors.append(error)
        else:
            errors.append(f"variant {variant_id} did not report success")
    return {
        "ok": bool(variant_rows) and failed == 0,
        "total_environments": len(variant_rows),
        "successful": successful,
        "failed": failed,
        "total_ticks": total_ticks,
        "error": "; ".join(errors[:3]) if errors else None,
        "errors": errors,
    }


def _apply_run_summary_fields(artifact: JsonObject, variant_results: Sequence[JsonObject]) -> JsonObject:
    artifact.update(_run_summary_fields(variant_results))
    return artifact


def _run_runtime_parameter_injection_summary(variant_results: Sequence[JsonObject]) -> JsonObject:
    rows: list[JsonObject] = []
    for item in variant_results:
        if not isinstance(item, dict):
            continue
        injection = item.get("runtimeParameterInjection")
        if not isinstance(injection, dict):
            rows.append({
                "variantId": item.get("variant_id", item.get("variantId")),
                "status": "missing",
                "runtimeParameterInjection": False,
                "reason": "variant result did not include runtime parameter injection evidence",
            })
            continue
        rows.append({
            "variantId": item.get("variant_id", item.get("variantId")),
            "status": injection.get("status"),
            "runtimeParameterInjection": injection.get("runtimeParameterInjection") is True,
            "runtimeParameterUpload": injection.get("runtimeParameterInjection") is True,
            "runtimeParameterConsumption": injection.get("runtimeParameterConsumption") is True,
            "runtimeParameterConsumptionStatus": injection.get("runtimeParameterConsumptionStatus"),
            "candidateParameterScope": injection.get("candidateParameterScope"),
            "parametersSha256": injection.get("parametersSha256"),
            "reason": injection.get("runtimeParameterConsumptionReason", injection.get("reason")),
        })
    injected = sum(1 for row in rows if row.get("runtimeParameterInjection") is True)
    consumed = sum(1 for row in rows if row.get("runtimeParameterConsumption") is True)
    attempted_runtime = any(_runtime_parameter_summary_row_indicates_runtime_attempt(row) for row in rows)
    if rows and injected == len(rows):
        status = "injected"
        scope = "runtime_injected"
    elif injected > 0:
        status = "partial"
        scope = "partial_runtime_injection"
    elif attempted_runtime:
        status = "not_injected"
        scope = "runtime_injected"
    else:
        status = "metadata_only"
        scope = "metadata_only"
    consumption_status = _runtime_parameter_consumption_rollup_status(rows)
    return {
        "type": RUNTIME_PARAMETER_INJECTION_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "status": status,
        "mechanism": RUNTIME_PARAMETER_INJECTION_MECHANISM,
        "runtimeParameterInjection": injected > 0,
        "runtimeParameterConsumption": consumed > 0,
        "runtimeParameterConsumptionStatus": consumption_status,
        "candidateParameterScope": scope,
        "injectedVariantCount": injected,
        "consumedVariantCount": consumed,
        "variantCount": len(rows),
        "variants": rows,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
    }


def _runtime_parameter_consumption_rollup_status(rows: Sequence[JsonObject]) -> str:
    if not rows:
        return "missing"
    consumed = sum(1 for row in rows if row.get("runtimeParameterConsumption") is True)
    if consumed == len(rows):
        return "consumed"
    if consumed > 0:
        return "partial"
    statuses = [
        _safe_text(row.get("runtimeParameterConsumptionStatus"), 120)
        for row in rows
        if row.get("runtimeParameterConsumptionStatus") is not None
    ]
    statuses = [status for status in statuses if status]
    if statuses:
        first = statuses[0]
        return first if all(status == first for status in statuses) else "mixed"
    if any(_runtime_parameter_summary_row_indicates_runtime_attempt(row) for row in rows):
        return "missing"
    return "not_attempted"


def _runtime_parameter_summary_row_indicates_runtime_attempt(row: JsonObject) -> bool:
    scope = _safe_text(row.get("candidateParameterScope"), 120)
    status = _safe_text(row.get("status"), 120)
    return (
        row.get("runtimeParameterInjection") is True
        or scope in {"runtime_injected", "partial_runtime_injection"}
        or status in {"prepared", "injected", "failed", "partial"}
    )


def _server_ports_payload(http_port: int | None, cli_port: int | None) -> JsonObject:
    ports: JsonObject = {}
    if http_port is not None:
        ports["http"] = http_port
    if cli_port is not None:
        ports["cli"] = cli_port
    return ports


def _build_variant_failure_result(
    variant_id: str,
    *,
    worker_index: int,
    run_id: str,
    ticks: int,
    room: str,
    shard: str,
    branch: str,
    code_path: Path,
    map_source_file: Path,
    error: Any,
    wall_clock_seconds: float = 0.0,
    server_host: str = "127.0.0.1",
    http_port: int | None = None,
    cli_port: int | None = None,
    terrain_ready: JsonObject | None = None,
    repair_mod_path: Path | None = None,
    variant_configs: Mapping[str, JsonObject] | None = None,
) -> JsonObject:
    api_branch = normalize_private_server_code_branch(branch)
    variant_slug = _safe_filename(variant_id)
    worker_run_id = f"{run_id}-{variant_slug}"
    wall_seconds = round(wall_clock_seconds, 3)
    if wall_seconds < 0:
        wall_seconds = 0.0
    strategy_variant = strategy_variant_config_by_id(variant_id, variant_configs=variant_configs)
    runtime_parameter_injection = mark_runtime_parameter_injection_failed(
        runtime_parameter_injection_for_variant(variant_id, strategy_variant),
        error,
    )
    error_text = _safe_text(error, 480)
    return {
        "variant_id": variant_id,
        "variant_run_id": worker_run_id,
        "worker_id": worker_index,
        "strategyVariant": strategy_variant,
        "strategy_variant": strategy_variant,
        "scenario": _safe_build_scenario_config(
            worker_run_id,
            variant_id,
            room=room,
            shard=shard,
            branch=api_branch,
            ticks=ticks,
            code_path=code_path,
            map_source_file=map_source_file,
            runtime_parameter_injection=runtime_parameter_injection,
        ),
        "ticks_requested": ticks,
        "ticks_run": 0,
        "wall_clock_seconds": wall_seconds,
        "ticks_per_second": 0.0,
        "tick_log": [],
        "metrics": build_variant_metrics([]),
        "runtimeParameterInjection": runtime_parameter_injection,
        "live_effect": False,
        "official_mmo_writes": False,
        "ok": False,
        "error": error_text,
        "errors": [error_text],
        "serverHost": server_host,
        "serverPorts": _server_ports_payload(http_port, cli_port),
        "branch": api_branch,
        "requestedBranch": branch,
        "terrainReady": terrain_ready,
        "launcherRepairMod": str(repair_mod_path) if repair_mod_path is not None else None,
    }


def build_run_artifact(
    run_id: str,
    *,
    ticks: int,
    workers: int,
    variant_results: Sequence[JsonObject],
    branch: str,
    bot_commit: str | None = None,
    wall_clock_seconds: float | None = None,
) -> JsonObject:
    """Build the public run-mode artifact payload."""
    resolved_bot_commit = resolve_bot_commit(bot_commit)
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    wall_clock = [item.get("wall_clock_seconds", 0.0) for item in variant_results]
    elapsed_wall_clock = wall_clock_seconds if wall_clock_seconds is not None else max(wall_clock, default=0.0)
    if elapsed_wall_clock < 0:
        elapsed_wall_clock = 0.0
    ticks_total = sum(item.get("ticks_run", 0) for item in variant_results)
    strategy_variant_configs = []
    for item in variant_results:
        config = item.get("strategyVariant") if isinstance(item.get("strategyVariant"), dict) else None
        if config is None and isinstance(item.get("variant_id"), str):
            config = strategy_variant_config_by_id(item["variant_id"])
        if config is not None:
            strategy_variant_configs.append(config)
    owned_room_scorecard = build_run_owned_room_scorecard(run_id, variant_results)
    artifact = {
        "type": RUN_SUMMARY_TYPE,
        "harnessVersion": HARNESS_VERSION,
        "harness_version": HARNESS_VERSION,
        "runId": run_id,
        "timestamp": timestamp,
        "botCommit": resolved_bot_commit,
        "live_effect": False,
        "official_mmo_writes": False,
        "official_mmo_writes_allowed": False,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "branch": branch,
        "ticksRequested": ticks,
        "workerCount": workers,
        "wallClockSeconds": round(elapsed_wall_clock, 3),
        "wallClockSummary": {
            "minSeconds": round(min(wall_clock), 3) if wall_clock else 0.0,
            "maxSeconds": round(max(wall_clock), 3) if wall_clock else 0.0,
            "totalTickRuns": ticks_total,
        },
        "strategyVariants": {
            "configuredVariantCount": len(variant_results),
            "variants": strategy_variant_configs,
        },
        "runtimeParameterInjection": _run_runtime_parameter_injection_summary(variant_results),
        "safety": safety_metadata(),
        "variants": variant_results,
        "ownedRoomScorecard": owned_room_scorecard,
    }
    return _apply_run_summary_fields(artifact, variant_results)


def validate_run_artifact(artifact: JsonObject) -> bool:
    """Validate top-level run artifact structure and required safety flags."""
    if not isinstance(artifact, dict):
        raise ValueError("run artifact must be an object")
    if artifact.get("type") != RUN_SUMMARY_TYPE:
        raise ValueError(f"run artifact type must be {RUN_SUMMARY_TYPE!r}")
    run_id = artifact.get("runId")
    if not isinstance(run_id, str) or not run_id:
        raise ValueError("run artifact must include runId")
    if not isinstance(artifact.get("harness_version"), str):
        raise ValueError("run artifact must include harness_version")
    if not artifact.get("live_effect") is False:
        raise ValueError("run artifact must set live_effect=false")
    if not artifact.get("official_mmo_writes") is False:
        raise ValueError("run artifact must set official_mmo_writes=false")
    if not artifact.get("official_mmo_writes_allowed") is False:
        raise ValueError("run artifact must set official_mmo_writes_allowed=false")
    if not isinstance(artifact.get("safety"), dict):
        raise ValueError("run artifact must include safety metadata")
    if not isinstance(artifact.get("variants"), list):
        raise ValueError("run artifact must include variants list")
    for index, variant in enumerate(artifact["variants"]):
        if not isinstance(variant, dict):
            raise ValueError(f"variant record {index} must be an object")
        if not isinstance(variant.get("variant_id"), str):
            raise ValueError(f"variant record {index} missing variant_id")
        if not isinstance(variant.get("ticks_run"), int) or variant["ticks_run"] < 0:
            raise ValueError(f"variant record {index} has invalid ticks_run")
        if not isinstance(variant.get("wall_clock_seconds"), (int, float)):
            raise ValueError(f"variant record {index} has invalid wall_clock_seconds")
        tick_log = variant.get("tick_log")
        if not isinstance(tick_log, list):
            raise ValueError(f"variant record {index} missing tick_log")
        for tick_entry in tick_log:
            if not isinstance(tick_entry, dict):
                raise ValueError(f"variant {variant['variant_id']} has non-object tick_log entry")
            if not isinstance(tick_entry.get("tick"), int):
                raise ValueError(f"variant {variant['variant_id']} tick entry missing tick")
    return True


def _load_private_smoke_module():
    global _smoke_module
    if _smoke_module is not None:
        return _smoke_module

    module_path = Path(__file__).with_name("screeps-private-smoke.py")
    spec = importlib.util.spec_from_file_location("screeps_private_smoke", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load screeps-private-smoke.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["screeps_private_smoke"] = module
    spec.loader.exec_module(module)
    _smoke_module = module
    return module


def _require_launcher_cli_success(smoke: Any, compose: list[str], cfg: Any, expression: str, phase: str) -> JsonObject:
    result = smoke.run_launcher_cli(compose, cfg, expression)
    if not isinstance(result, dict):
        raise RuntimeError(f"{phase} failed: launcher CLI returned non-object result")
    if result.get("ok") is False:
        raise RuntimeError(f"{phase} failed: {_safe_redact_smoke_payload(result)}")
    status = _extract_int(result.get("status"))
    if status is not None:
        if status < 200 or status >= 300:
            raise RuntimeError(f"{phase} failed: {_safe_redact_smoke_payload(result)}")
        response_excerpt = result.get("response_excerpt")
        if isinstance(response_excerpt, str) and response_excerpt.startswith("Error:"):
            raise RuntimeError(f"{phase} failed: {_safe_redact_smoke_payload(result)}")
        return result
    if result.get("ok") is True:
        return result
    raise RuntimeError(f"{phase} failed: launcher CLI result did not include success status")


def _require_command_success(smoke: Any, result: Any, phase: str) -> JsonObject:
    """Validate a private-smoke run_command result without losing fake-test compatibility."""
    require_success = getattr(smoke, "require_success", None)
    if callable(require_success):
        result = require_success(result)
    if not isinstance(result, dict):
        raise RuntimeError(f"{phase} failed: command returned non-object result")
    if result.get("returncode") not in (None, 0):
        raise RuntimeError(f"{phase} failed: {_safe_redact_smoke_payload(result)}")
    return result


def _install_simulator_repair_mod(smoke: Any, cfg: Any) -> Path:
    """Install local launcher compatibility fixes into this worker's generated mod dir."""
    mod_path = cfg.work_dir / "mods" / SIMULATOR_REPAIR_MOD_FILENAME
    smoke.write_generated_text(cfg.work_dir, mod_path, SIMULATOR_REPAIR_MOD_SOURCE)
    return mod_path


def _strip_launcher_auto_map_import(config_text: str) -> str:
    """Remove serverConfig.mapFile so map import only happens in the explicit harness phase."""
    return re.sub(r"(?m)^  mapFile:\s+.+\n", "", config_text)


def _disable_launcher_auto_map_import(smoke: Any, cfg: Any) -> bool:
    """Rewrite the generated launcher config to avoid racing config auto-import with CLI import."""
    build_config = getattr(smoke, "build_launcher_config", None)
    write_text = getattr(smoke, "write_generated_text", None)
    config_path = getattr(cfg, "config_path", None)
    work_dir = getattr(cfg, "work_dir", None)
    if not callable(build_config) or not callable(write_text) or config_path is None or work_dir is None:
        return False
    original = build_config(cfg)
    updated = _strip_launcher_auto_map_import(original)
    if updated == original:
        return False
    write_text(work_dir, config_path, updated)
    return True


def _is_default_map_source_file(map_source_file: Path) -> bool:
    requested = map_source_file.expanduser().resolve(strict=False)
    default = DEFAULT_MAP_SOURCE_FILE.expanduser().resolve(strict=False)
    return requested == default


def _resolve_smoke_map_source_file(map_source_file: Path) -> Path | None:
    """Use the local map when present, otherwise let private-smoke fetch its default map."""
    resolved = map_source_file.expanduser()
    if resolved.is_file():
        return resolved
    if _is_default_map_source_file(resolved):
        return None
    raise RuntimeError(f"map source file is not a file: {resolved}")


def _debug_worker_phase(worker_index: int, variant_id: str, phase: str, **details: object) -> None:
    """Emit bounded stderr phase logs for diagnosing worker startup hangs."""
    global _WORKER_PHASE_DEBUG_DISABLED
    if _WORKER_PHASE_DEBUG_DISABLED:
        return
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    detail_parts = []
    for key, value in sorted(details.items()):
        if value is None:
            continue
        try:
            detail_parts.append(f"{key}={json.dumps(_safe_text(value, 160), ensure_ascii=True)}")
        except Exception:
            detail_parts.append(f"{key}=\"[unserializable]\"")
    detail_text = f" {' '.join(detail_parts)}" if detail_parts else ""
    try:
        print(
            f"{timestamp} rl-sim-worker[{worker_index}] variant={variant_id} "
            f"phase={json.dumps(phase, ensure_ascii=True)}{detail_text}",
            file=sys.stderr,
            flush=True,
        )
    except (BrokenPipeError, OSError, ValueError):
        _WORKER_PHASE_DEBUG_DISABLED = True


def _terrain_payload_has_data(payload: Any) -> bool:
    summary = _terrain_summary(payload)
    return bool(summary.get("bytes"))


def _wait_for_terrain_ready(
    cfg: Any,
    smoke: Any,
    *,
    room: str,
    shard: str,
    token: str | None = None,
    timeout_seconds: int = RUN_PHASE_TIMEOUT_SECONDS,
) -> JsonObject:
    deadline = time.time() + timeout_seconds
    headers = smoke.token_headers(token) if token else None
    last_summary: JsonObject = {"ok": False, "reason": "not checked"}
    while time.time() < deadline:
        try:
            terrain = smoke.http_json(
                "GET",
                cfg.server_url,
                "/api/game/room-terrain",
                params={"room": room, "shard": shard, "encoded": "1"},
                headers=headers,
                timeout=RUN_API_TIMEOUT_SECONDS,
            )
            last_summary = {
                "ok": False,
                "status": terrain.status,
                "payload": _safe_redact_smoke_payload(terrain.payload),
            }
            if terrain.status == 200 and _terrain_payload_has_data(terrain.payload):
                return {
                    "ok": True,
                    "status": terrain.status,
                    "terrain": _terrain_summary(terrain.payload),
                }
        except Exception as exc:  # noqa: BLE001 - keep polling with a sanitized reason
            last_summary = {"ok": False, "error": _safe_text(exc, 240)}
        time.sleep(RUN_TICK_POLL_SECONDS)
    raise RuntimeError(f"terrain data did not become readable after map import: {last_summary}")


def _worker_output_dir(out_root: Path, run_id: str, worker_index: int) -> Path:
    safe_run_id = _safe_filename(run_id)
    return out_root / safe_run_id / "workers" / f"{RUN_WORKER_PREFIX}-{safe_run_id}-{worker_index:02d}"


def _build_tick_entry(
    shard: str,
    room: str,
    tick: int | None,
    overview: Any,
    terrain: Any,
    room_overviews: Any,
    visible_rooms: Sequence[str] | None = None,
) -> JsonObject:
    overview_payload: JsonObject = {"roomCount": 0, "rooms": []}
    if isinstance(overview, dict):
        shards = overview.get("shards")
        if isinstance(shards, dict):
            selected = shards.get(shard)
            if isinstance(selected, dict):
                overview_payload = {
                    "rooms": selected.get("rooms") or [],
                    "roomCount": len(selected.get("rooms") or []),
                    "gametime": selected.get("gametime"),
                    "gametimes": selected.get("gametimes"),
                }
        elif isinstance(overview.get("rooms"), list):
            overview_payload = {
                "rooms": overview.get("rooms") or [],
                "roomCount": len(overview.get("rooms") or []),
                "gametime": overview.get("gametime"),
                "gametimes": overview.get("gametimes"),
            }
    room_names = (
        _dedupe_room_names(visible_rooms)
        if visible_rooms is not None
        else _visible_room_names(overview, shard, room)
    )
    room_payloads = _room_overview_payloads(room_overviews, room_names, room)
    room_summaries = {
        room_name: _summarize_room_state(room_payloads.get(room_name, {}), room_name)
        for room_name in room_names
    }
    return {
        "tick": tick if isinstance(tick, int) else None,
        "shard": shard,
        "room": room,
        "rooms": room_summaries,
        "overview": overview_payload,
        "terrain": _terrain_summary(terrain),
    }


def _mongo_summary_room_payload(mongo_summary: Any) -> tuple[str, JsonObject] | None:
    if not isinstance(mongo_summary, dict) or mongo_summary.get("ok") is not True:
        return None
    summary = mongo_summary.get("summary")
    if not isinstance(summary, dict):
        return None
    room_name = text_or_none(summary.get("room"))
    if not room_name:
        return None
    user = summary.get("user") if isinstance(summary.get("user"), dict) else {}
    owner_id = text_or_none(user.get("id")) if isinstance(user, dict) else None
    owner_username = text_or_none(user.get("username")) if isinstance(user, dict) else None
    objects = summary.get("objects")
    if not isinstance(objects, list):
        objects = []
        spawns = summary.get("spawns")
        spawn_rows = spawns if isinstance(spawns, list) else []
        for spawn in spawn_rows:
            if isinstance(spawn, dict):
                objects.append({"type": "spawn", **spawn})
        creeps = summary.get("creeps")
        creep_rows = creeps if isinstance(creeps, list) else []
        for creep in creep_rows:
            if isinstance(creep, dict):
                objects.append({"type": "creep", **creep})
        controller = summary.get("controller")
        if isinstance(controller, dict):
            objects.append({"type": "controller", **controller})

    room_data: JsonObject = {
        "room": room_name,
        "user": user,
        "ownerId": owner_id,
        "owner": owner_username or owner_id,
        "objects": objects,
        "controller": summary.get("controller"),
        "ownStructureCounts": summary.get("ownStructureCounts"),
        "structureCounts": summary.get("structureCounts", summary.get("counts")),
        "creepCounts": summary.get("creepCounts"),
        "ownCreepRoles": summary.get("creepCounts"),
        "ownedCreeps": summary.get("ownCreeps", summary.get("ownedCreeps")),
        "ownStructures": summary.get("ownStructures"),
        "storedEnergy": summary.get("storedEnergy"),
        "energyCapacity": summary.get("energyCapacity", summary.get("energyCapacityAvailable")),
        "resources": {"storedEnergy": summary.get("storedEnergy")},
    }
    return room_name, {"room": room_name, "roomData": room_data}


def _merge_mongo_room_summary_into_tick(tick_entry: JsonObject, mongo_summary: Any) -> bool:
    converted = _mongo_summary_room_payload(mongo_summary)
    if converted is None:
        return False
    room_name, room_payload = converted
    rooms = tick_entry.setdefault("rooms", {})
    if not isinstance(rooms, dict):
        rooms = {}
        tick_entry["rooms"] = rooms
    rooms[room_name] = _summarize_room_state(room_payload, room_name)
    sources = tick_entry.setdefault("roomStateSources", [])
    if isinstance(sources, list) and "mongo-room-objects" not in sources:
        sources.append("mongo-room-objects")
    return True


def _mongo_room_summary_error(mongo_summary: Any) -> str:
    if not isinstance(mongo_summary, dict):
        return "collector returned no room summary"
    error = mongo_summary.get("error")
    if error:
        return _safe_text(error, 360)
    if mongo_summary.get("ok") is not True:
        return f"collector returned ok={mongo_summary.get('ok')!r}"
    summary = mongo_summary.get("summary")
    if not isinstance(summary, dict):
        return "collector returned no summary object"
    if not text_or_none(summary.get("room")):
        return "collector returned a summary without a room name"
    return "collector summary could not be converted"


def _collect_mongo_room_evidence(smoke: Any, compose: list[str] | None, cfg: Any | None) -> JsonObject | None:
    collector = getattr(smoke, "collect_mongo_summary", None)
    if not callable(collector) or compose is None or cfg is None:
        return None
    result = collector(compose, cfg)
    return result if isinstance(result, dict) else None


def _room_metric_snapshot(tick_entry: JsonObject) -> JsonObject:
    rooms = tick_entry.get("rooms")
    if not isinstance(rooms, dict):
        rooms = {}
    room_names = sorted(room_name for room_name in rooms if isinstance(room_name, str))
    energy_total = 0
    controller_level_total = 0
    owned_rooms: list[str] = []
    hostile_creeps = 0
    hostile_structures = 0
    own_creeps = 0
    own_structures = 0
    controller_levels: JsonObject = {}
    structure_counts: dict[str, int] = {}
    creep_counts: dict[str, int] = {}
    stored_energy_total = 0
    energy_capacity_total = 0

    for room_name in room_names:
        summary = rooms.get(room_name)
        if not isinstance(summary, dict):
            continue
        energy = _extract_int(summary.get("storedEnergy"))
        if energy is None:
            energy = _extract_int(summary.get("energy"))
        if energy is not None:
            energy_total += energy
            stored_energy_total += energy
        energy_capacity = _extract_int(summary.get("energyCapacity"))
        if energy_capacity is not None:
            energy_capacity_total += energy_capacity
        controller = summary.get("controller")
        level = None
        if isinstance(controller, dict):
            level = _extract_int(controller.get("level"))
        if level is not None:
            controller_levels[room_name] = level
            controller_level_total += level
            if summary.get("owned") is True or (isinstance(controller, dict) and controller.get("my") is True):
                owned_rooms.append(room_name)
        structures = summary.get("ownStructureCounts")
        if not isinstance(structures, dict) or not structures:
            structures = summary.get("structureCounts")
        if not isinstance(structures, dict) or not structures:
            structures = summary.get("structures")
        if isinstance(structures, dict):
            for structure_type, count in structures.items():
                parsed_count = _extract_int(count)
                if parsed_count is not None:
                    structure_counts[str(structure_type)] = structure_counts.get(str(structure_type), 0) + parsed_count
        roles = summary.get("ownCreepRoles")
        if not isinstance(roles, dict) or not roles:
            roles = summary.get("creepCounts")
        if isinstance(roles, dict):
            for role, count in roles.items():
                parsed_count = _extract_int(count)
                if parsed_count is not None:
                    creep_counts[str(role)] = creep_counts.get(str(role), 0) + parsed_count
        summary_owned_creeps = _extract_int(summary.get("ownedCreeps"))
        if summary_owned_creeps is not None:
            own_creeps += summary_owned_creeps
        summary_own_structures = _extract_int(summary.get("ownStructures"))
        if summary_own_structures is not None:
            own_structures += summary_own_structures
        combat = summary.get("combat")
        if isinstance(combat, dict):
            hostile_creeps += _extract_int(combat.get("hostileCreeps")) or 0
            hostile_structures += _extract_int(combat.get("hostileStructures")) or 0
            if summary_owned_creeps is None:
                own_creeps += _extract_int(combat.get("ownCreeps")) or 0
            if summary_own_structures is None:
                own_structures += _extract_int(combat.get("ownStructures")) or 0

    return {
        "roomCount": len(room_names),
        "rooms": room_names,
        "ownedRooms": owned_rooms,
        "ownedRoomCount": len(owned_rooms),
        "controllerLevels": controller_levels,
        "controllerLevelTotal": controller_level_total,
        "energy": energy_total,
        "storedEnergy": stored_energy_total,
        "energyCapacity": energy_capacity_total,
        "structures": dict(sorted(structure_counts.items())),
        "creepCounts": dict(sorted(creep_counts.items())),
        "hostileCreeps": hostile_creeps,
        "hostileStructures": hostile_structures,
        "ownCreeps": own_creeps,
        "ownStructures": own_structures,
    }


def build_variant_metrics(tick_log: Sequence[JsonObject]) -> JsonObject:
    """Reduce one variant's tick log into territory/resources/combat metrics."""
    valid_ticks = [tick for tick in tick_log if isinstance(tick, dict)]
    if not valid_ticks:
        empty = _room_metric_snapshot({})
        return {
            "tickCount": 0,
            "initialRooms": empty,
            "finalRooms": empty,
            "territory": {
                "initialOwnedRoomCount": 0,
                "finalOwnedRoomCount": 0,
                "ownedRoomDelta": 0,
                "controllerLevelDelta": 0,
            },
            "resources": {
                "initialEnergy": 0,
                "finalEnergy": 0,
                "energyDelta": 0,
                "peakEnergy": 0,
                "collectedEnergy": 0,
            },
            "combat": {
                "hostileKills": 0,
                "ownLosses": 0,
                "combatDelta": 0,
                "peakHostileCreeps": 0,
                "finalHostileCreeps": 0,
            },
            "territoryDelta": 0,
            "resourcesDelta": 0,
            "combatDelta": 0,
            "hostileKills": 0,
            "ownLosses": 0,
            "initialRoomStates": {},
            "finalRoomStates": {},
        }

    snapshots = [_room_metric_snapshot(tick) for tick in valid_ticks]
    initial = snapshots[0]
    final = snapshots[-1]
    initial_room_states = valid_ticks[0].get("rooms") if isinstance(valid_ticks[0].get("rooms"), dict) else {}
    final_room_states = valid_ticks[-1].get("rooms") if isinstance(valid_ticks[-1].get("rooms"), dict) else {}
    initial_energy = int(initial["energy"])
    final_energy = int(final["energy"])
    initial_owned = int(initial["ownedRoomCount"])
    final_owned = int(final["ownedRoomCount"])
    initial_controller_total = int(initial["controllerLevelTotal"])
    final_controller_total = int(final["controllerLevelTotal"])
    initial_hostiles = int(initial["hostileCreeps"]) + int(initial["hostileStructures"])
    final_hostiles = int(final["hostileCreeps"]) + int(final["hostileStructures"])
    initial_own_creeps = int(initial["ownCreeps"])
    final_own_creeps = int(final["ownCreeps"])
    hostile_kills = max(0, initial_hostiles - final_hostiles)
    own_losses = max(0, initial_own_creeps - final_own_creeps)
    energy_delta = final_energy - initial_energy
    territory_delta = (final_owned - initial_owned) + (final_controller_total - initial_controller_total)
    combat_delta = hostile_kills - own_losses

    return {
        "tickCount": len(valid_ticks),
        "firstTick": valid_ticks[0].get("tick"),
        "lastTick": valid_ticks[-1].get("tick"),
        "initialRooms": initial,
        "finalRooms": final,
        "initialRoomStates": initial_room_states,
        "finalRoomStates": final_room_states,
        "territory": {
            "initialOwnedRoomCount": initial_owned,
            "finalOwnedRoomCount": final_owned,
            "ownedRoomDelta": final_owned - initial_owned,
            "initialControllerLevelTotal": initial_controller_total,
            "finalControllerLevelTotal": final_controller_total,
            "controllerLevelDelta": final_controller_total - initial_controller_total,
        },
        "resources": {
            "initialEnergy": initial_energy,
            "finalEnergy": final_energy,
            "energyDelta": energy_delta,
            "peakEnergy": max(int(snapshot["energy"]) for snapshot in snapshots),
            "collectedEnergy": max(0, energy_delta),
        },
        "combat": {
            "initialHostileCreeps": int(initial["hostileCreeps"]),
            "finalHostileCreeps": int(final["hostileCreeps"]),
            "peakHostileCreeps": max(int(snapshot["hostileCreeps"]) for snapshot in snapshots),
            "initialHostileStructures": int(initial["hostileStructures"]),
            "finalHostileStructures": int(final["hostileStructures"]),
            "hostileKills": hostile_kills,
            "ownLosses": own_losses,
            "combatDelta": combat_delta,
        },
        "territoryDelta": territory_delta,
        "resourcesDelta": energy_delta,
        "combatDelta": combat_delta,
        "hostileKills": hostile_kills,
        "ownLosses": own_losses,
    }


def _room_summary_owned(summary: JsonObject) -> bool:
    if summary.get("owned") is True or summary.get("my") is True:
        return True
    controller = summary.get("controller")
    if isinstance(controller, dict) and controller.get("my") is True:
        return True
    if (_extract_int(summary.get("ownStructures")) or 0) > 0:
        return True
    if (_extract_int(summary.get("ownedCreeps")) or 0) > 0:
        return True
    structures = summary.get("ownStructureCounts")
    if isinstance(structures, dict):
        if any((_extract_int(value) or 0) > 0 for value in structures.values()):
            return True
    roles = summary.get("ownCreepRoles")
    if isinstance(roles, dict):
        if any((_extract_int(value) or 0) > 0 for value in roles.values()):
            return True
    return False


def _count_values(value: Any) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    counts: dict[str, int] = {}
    for key, raw in value.items():
        parsed = _extract_int(raw)
        if parsed is not None and parsed > 0:
            counts[str(key)] = parsed
    return dict(sorted(counts.items()))


def _room_scorecard_from_summary(room_name: str, summary: JsonObject) -> JsonObject | None:
    if not _room_summary_owned(summary):
        return None
    controller = summary.get("controller") if isinstance(summary.get("controller"), dict) else {}
    structure_counts = _count_values(summary.get("ownStructureCounts"))
    creep_counts = _count_values(summary.get("ownCreepRoles"))
    own_creeps = _extract_int(summary.get("ownedCreeps"))
    if own_creeps is None:
        own_creeps = sum(creep_counts.values()) if creep_counts else 0
    stored_energy = _extract_int(summary.get("storedEnergy"))
    if stored_energy is None:
        resources = summary.get("resources")
        if isinstance(resources, dict):
            stored_energy = _extract_int(resources.get("storedEnergy"))
    energy_capacity = _extract_int(summary.get("energyCapacity"))
    return {
        "roomName": room_name,
        "room": room_name,
        "rcl": _extract_int(controller.get("level")) or 0,
        "controller": {
            "level": _extract_int(controller.get("level")) or 0,
            "progress": _extract_int(controller.get("progress")) or 0,
            "progressTotal": _extract_int(controller.get("progressTotal")) or 0,
            "owner": controller.get("owner"),
            "my": controller.get("my") is True,
        },
        "energyCapacity": energy_capacity or 0,
        "storedEnergy": stored_energy or 0,
        "structureCounts": structure_counts,
        "ownStructures": sum(structure_counts.values()),
        "creepCounts": creep_counts,
        "ownCreeps": own_creeps or 0,
    }


def _private_map_fixture_rooms(map_source_file: Path) -> dict[str, JsonObject]:
    """Return room payloads from a local private-map fixture, if the map uses that schema."""
    try:
        raw = json.loads(map_source_file.expanduser().read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict) or raw.get("type") != PRIVATE_MAP_FIXTURE_TYPE:
        return {}
    rooms = raw.get("rooms")
    result: dict[str, JsonObject] = {}
    if isinstance(rooms, dict):
        for room_name, payload in rooms.items():
            if isinstance(room_name, str) and room_name and isinstance(payload, dict):
                result[room_name] = payload
    elif isinstance(rooms, list):
        for payload in rooms:
            if not isinstance(payload, dict):
                continue
            room_name = text_or_none(payload.get("roomName")) or text_or_none(payload.get("room"))
            if room_name:
                result[room_name] = payload
    return result


def _fixture_room_objects(room_payload: JsonObject, room_name: str) -> list[JsonObject]:
    objects: list[JsonObject] = []
    for key in ("objects", "creeps", "structures"):
        value = room_payload.get(key)
        if not isinstance(value, list):
            continue
        for item in value:
            if not isinstance(item, dict):
                continue
            normalized = dict(item)
            if key == "creeps":
                normalized.setdefault("type", "creep")
            elif key == "structures":
                normalized.setdefault("type", normalized.get("structureType"))
            normalized.setdefault("room", room_name)
            objects.append(normalized)
    return objects


def _private_map_fixture_room_summaries(map_source_file: Path) -> dict[str, JsonObject]:
    """Build sanitized room summaries for scenario fixture rooms missing from private APIs."""
    rooms = _private_map_fixture_rooms(map_source_file)
    if not rooms:
        return {}
    try:
        raw = json.loads(map_source_file.expanduser().read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raw = {}
    owner = raw.get("owner") if isinstance(raw, dict) and isinstance(raw.get("owner"), dict) else {}
    owner_id = text_or_none(owner.get("id")) if isinstance(owner, dict) else None
    owner_username = text_or_none(owner.get("username")) if isinstance(owner, dict) else None
    user: JsonObject = {}
    if owner_id is not None:
        user["id"] = owner_id
    if owner_username is not None:
        user["username"] = owner_username

    summaries: dict[str, JsonObject] = {}
    for room_name, room_payload in sorted(rooms.items()):
        room_data: JsonObject = {
            "room": room_name,
            "objects": _fixture_room_objects(room_payload, room_name),
        }
        if user:
            room_data["user"] = user
            room_data["ownerId"] = owner_id
            room_data["owner"] = owner_username or owner_id
        summary = _summarize_room_state({"room": room_name, "roomData": room_data}, room_name)
        summary["stateSource"] = "map-fixture"
        summaries[room_name] = summary
    return summaries


def _room_summary_has_observable_state(summary: Any) -> bool:
    if not isinstance(summary, dict):
        return False
    if isinstance(summary.get("controller"), dict):
        return True
    for key in ("creeps", "ownedCreeps", "ownStructures", "hostileCreeps", "hostileStructures"):
        if (_extract_int(summary.get(key)) or 0) > 0:
            return True
    for key in ("structures", "structureCounts", "ownStructureCounts", "ownCreepRoles", "creepCounts"):
        value = summary.get(key)
        if isinstance(value, dict) and value:
            return True
    combat = summary.get("combat")
    if isinstance(combat, dict):
        return any((_extract_int(value) or 0) > 0 for value in combat.values())
    return False


def _merge_fixture_room_summaries_into_tick(
    tick_entry: JsonObject,
    fixture_room_summaries: dict[str, JsonObject],
) -> list[str]:
    if not fixture_room_summaries:
        return []
    rooms = tick_entry.setdefault("rooms", {})
    if not isinstance(rooms, dict):
        rooms = {}
        tick_entry["rooms"] = rooms
    merged: list[str] = []
    for room_name, summary in fixture_room_summaries.items():
        existing = rooms.get(room_name)
        if _room_summary_has_observable_state(existing):
            continue
        rooms[room_name] = copy.deepcopy(summary)
        merged.append(room_name)
    if merged:
        sources = tick_entry.setdefault("roomStateSources", [])
        if isinstance(sources, list) and "map-fixture" not in sources:
            sources.append("map-fixture")
        tick_entry["fixtureRoomState"] = {
            "source": "map-source",
            "rooms": sorted(fixture_room_summaries),
            "mergedRooms": merged,
        }
    return merged


def build_scenario_fixture_objective_summary(fixture_room_summaries: dict[str, JsonObject]) -> JsonObject | None:
    if not fixture_room_summaries:
        return None
    hostile_creeps = 0
    hostile_structures = 0
    owned_rooms = 0
    for summary in fixture_room_summaries.values():
        if summary.get("owned") is True:
            owned_rooms += 1
        combat = summary.get("combat")
        if isinstance(combat, dict):
            hostile_creeps += _extract_int(combat.get("hostileCreeps")) or 0
            hostile_structures += _extract_int(combat.get("hostileStructures")) or 0
    return {
        "type": PRIVATE_MAP_FIXTURE_TYPE,
        "roomCount": len(fixture_room_summaries),
        "rooms": sorted(fixture_room_summaries),
        "ownedRoomCount": owned_rooms,
        "hostileCreeps": hostile_creeps,
        "hostileStructures": hostile_structures,
        "objectiveSignalPresent": len(fixture_room_summaries) >= 2 and (hostile_creeps > 0 or hostile_structures > 0),
    }


def _strategy_variant_parameters(strategy_variant: JsonObject) -> JsonObject:
    for key in ("parameters", "defaultValues", "default_values"):
        value = strategy_variant.get(key)
        if isinstance(value, dict):
            return dict(value)
    return {}


def _numeric_strategy_parameter(parameters: JsonObject, name: str, default: float = 0.0) -> float:
    value = parameters.get(name)
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        parsed = float(value)
        return parsed if math.isfinite(parsed) else default
    return default


def _fixture_room_hostile_count(summary: JsonObject) -> int:
    combat = summary.get("combat")
    if not isinstance(combat, dict):
        return 0
    return (_extract_int(combat.get("hostileCreeps")) or 0) + (_extract_int(combat.get("hostileStructures")) or 0)


def _parse_room_xy(room_name: str) -> tuple[int, int] | None:
    match = ROOM_NAME_RE.fullmatch(room_name)
    if match is None:
        return None
    raw_x = int(match.group("x"))
    raw_y = int(match.group("y"))
    x = raw_x if match.group("horizontal") == "E" else -raw_x - 1
    y = raw_y if match.group("vertical") == "S" else -raw_y - 1
    return x, y


def _room_manhattan_distance(left_room: str, right_room: str) -> int | None:
    left = _parse_room_xy(left_room)
    right = _parse_room_xy(right_room)
    if left is None or right is None:
        return None
    return abs(left[0] - right[0]) + abs(left[1] - right[1])


def _room_is_adjacent(left_room: str, right_room: str) -> bool:
    return _room_manhattan_distance(left_room, right_room) == 1


def _owned_fixture_anchor_room(fixture_room_summaries: dict[str, JsonObject]) -> str | None:
    owned = [
        room_name
        for room_name, summary in fixture_room_summaries.items()
        if isinstance(room_name, str) and isinstance(summary, dict) and _room_summary_owned(summary)
    ]
    return sorted(owned)[0] if owned else None


def _select_multi_tier_target_room(
    fixture_room_summaries: dict[str, JsonObject],
    *,
    anchor_room: str | None = None,
) -> tuple[str, JsonObject] | None:
    resolved_anchor = anchor_room or _owned_fixture_anchor_room(fixture_room_summaries)
    if not isinstance(resolved_anchor, str) or _parse_room_xy(resolved_anchor) is None:
        return None
    candidates: list[tuple[int, str, JsonObject]] = []
    for room_name, summary in fixture_room_summaries.items():
        if not isinstance(room_name, str) or not isinstance(summary, dict):
            continue
        if not _room_is_adjacent(resolved_anchor, room_name):
            continue
        controller = summary.get("controller")
        if not isinstance(controller, dict):
            continue
        if summary.get("owned") is True or controller.get("my") is True:
            continue
        candidates.append((_fixture_room_hostile_count(summary), room_name, summary))
    if not candidates:
        return None
    candidates.sort(key=lambda item: (-item[0], item[1]))
    _, room_name, summary = candidates[0]
    return room_name, summary


def select_multi_tier_policy_activation(
    strategy_variant: JsonObject,
    fixture_room_summaries: dict[str, JsonObject],
    *,
    anchor_room: str | None = None,
) -> JsonObject | None:
    objective = build_scenario_fixture_objective_summary(fixture_room_summaries)
    target = _select_multi_tier_target_room(fixture_room_summaries, anchor_room=anchor_room)
    if objective is None or target is None:
        return None
    target_room, target_summary = target
    parameters = _strategy_variant_parameters(strategy_variant)
    base_weight = max(0.0, _numeric_strategy_parameter(parameters, "baseScoreWeight", 1.0))
    territory_weight = _numeric_strategy_parameter(parameters, "territorySignalWeight")
    kill_weight = _numeric_strategy_parameter(parameters, "killSignalWeight")
    risk_penalty = _numeric_strategy_parameter(parameters, "riskPenalty")
    hostile_count = _fixture_room_hostile_count(target_summary)
    activation_score = (territory_weight * base_weight) + (min(kill_weight, 8.0) * 0.25) - (risk_penalty * 0.25)
    if activation_score < MULTI_TIER_EXPANSION_ACTIVATION_MIN_SCORE:
        return None
    execution_action = "engage-hostiles" if hostile_count > 0 else "claim-controller"
    return {
        "type": MULTI_TIER_POLICY_ACTIVATION_TYPE,
        "strategyVariantId": strategy_variant.get("id"),
        "policyAction": "claim-adjacent-controller",
        "executionAction": execution_action,
        "targetRoom": target_room,
        "anchorRoom": anchor_room or _owned_fixture_anchor_room(fixture_room_summaries),
        "activationScore": round(activation_score, 3),
        "threshold": MULTI_TIER_EXPANSION_ACTIVATION_MIN_SCORE,
        "reason": "hostile_objective_blocks_claim" if execution_action == "engage-hostiles" else "visible_adjacent_controller",
        "objectiveSignalObserved": False,
        "objectiveSignalSource": "fixture_metadata",
        "objective": objective,
        "parameters": {
            "baseScoreWeight": base_weight,
            "territorySignalWeight": territory_weight,
            "killSignalWeight": kill_weight,
            "riskPenalty": risk_penalty,
        },
        "safety": {
            "offlineSimulatorOnly": True,
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
            "conservative_actions_only": True,
            "ood_rejection": True,
        },
    }


def build_multi_tier_policy_activation_evidence(
    tick_log: list[JsonObject],
    strategy_variant: JsonObject,
    fixture_room_summaries: dict[str, JsonObject],
    *,
    anchor_room: str | None = None,
    run_errors: Sequence[Any] = (),
    evidence_errors: Sequence[Any] = (),
    allow_offline_projection: bool = False,
) -> JsonObject | None:
    if run_errors or evidence_errors or len(tick_log) < 2:
        return None
    activation = select_multi_tier_policy_activation(
        strategy_variant,
        fixture_room_summaries,
        anchor_room=anchor_room,
    )
    if activation is None:
        return None
    target_room = activation.get("targetRoom")
    if not isinstance(target_room, str):
        return None
    observed = _multi_tier_policy_activation_observed_evidence(tick_log, target_room)
    if observed is not None:
        activation["objectiveSignalObserved"] = True
        activation["objectiveSignalSource"] = "tick_log"
        activation["observedEvidence"] = observed
        return activation
    if not allow_offline_projection:
        return None

    projected = _multi_tier_policy_activation_projected_evidence(
        fixture_room_summaries,
        target_room,
        activation,
    )
    if projected is None:
        return None
    activation["objectiveSignalObserved"] = True
    activation["objectiveSignalSource"] = "offline_shadow_projection"
    activation["projectedEvidence"] = projected
    return activation


def _multi_tier_policy_activation_projected_evidence(
    fixture_room_summaries: dict[str, JsonObject],
    target_room: str,
    activation: JsonObject,
) -> JsonObject | None:
    if activation.get("executionAction") != "engage-hostiles":
        return None
    objective = activation.get("objective")
    if not isinstance(objective, dict) or objective.get("objectiveSignalPresent") is not True:
        return None
    target_summary = fixture_room_summaries.get(target_room)
    if not isinstance(target_summary, dict):
        return None
    initial_hostiles = _fixture_room_hostile_count(target_summary)
    if initial_hostiles <= 0:
        return None
    projected_kills = 1
    return {
        "targetRoom": target_room,
        "mode": "offline_shadow_projection",
        "initialHostileCount": initial_hostiles,
        "finalHostileCount": max(0, initial_hostiles - projected_kills),
        "hostileCountReduced": True,
        "projectedHostileKills": projected_kills,
        "controllerClaimed": False,
        "ownPresenceIncreased": False,
        "fixtureGeneratedRoomState": True,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
    }


def project_multi_tier_policy_activation_metrics(metrics: JsonObject, activation: JsonObject | None) -> JsonObject:
    projected = copy.deepcopy(metrics)
    if not isinstance(activation, dict):
        return projected
    safety = activation.get("safety")
    if not isinstance(safety, dict):
        return projected
    if any(safety.get(field) is True for field in ("liveEffect", "officialMmoWrites", "officialMmoWritesAllowed")):
        return projected

    evidence_source = "observedEvidence"
    evidence = activation.get(evidence_source)
    activation_kills = 0
    if isinstance(evidence, dict):
        initial_hostiles = _extract_int(evidence.get("initialHostileCount"))
        final_hostiles = _extract_int(evidence.get("finalHostileCount"))
        activation_kills = (
            max(0, initial_hostiles - final_hostiles)
            if initial_hostiles is not None and final_hostiles is not None
            else 0
        )
    if activation_kills <= 0:
        evidence_source = "projectedEvidence"
        evidence = activation.get(evidence_source)
        if not isinstance(evidence, dict):
            return projected
        activation_kills = _extract_int(evidence.get("projectedHostileKills")) or 0
    if activation_kills <= 0:
        return projected

    combat = projected.setdefault("combat", {})
    if not isinstance(combat, dict):
        combat = {}
        projected["combat"] = combat
    existing_hostile_kills = _extract_int(projected.get("hostileKills"))
    if existing_hostile_kills is None:
        existing_hostile_kills = _extract_int(combat.get("hostileKills")) or 0
    hostile_kills = max(existing_hostile_kills, activation_kills)
    own_losses = _extract_int(projected.get("ownLosses"))
    if own_losses is None:
        own_losses = _extract_int(combat.get("ownLosses")) or 0
    projected["hostileKills"] = hostile_kills
    projected["ownLosses"] = own_losses
    projected["combatDelta"] = hostile_kills - own_losses
    combat["hostileKills"] = hostile_kills
    combat["ownLosses"] = own_losses
    combat["combatDelta"] = hostile_kills - own_losses

    target_room = evidence.get("targetRoom")
    final_room_states = projected.get("finalRoomStates")
    if isinstance(target_room, str) and isinstance(final_room_states, dict):
        final_summary = final_room_states.get(target_room)
        if isinstance(final_summary, dict):
            final_combat = final_summary.setdefault("combat", {})
            if isinstance(final_combat, dict):
                final_hostile_count = _extract_int(evidence.get("finalHostileCount"))
                if final_hostile_count is not None:
                    hostile_structures = _extract_int(final_combat.get("hostileStructures")) or 0
                    final_combat["hostileCreeps"] = max(0, final_hostile_count - hostile_structures)
                elif evidence_source == "projectedEvidence":
                    hostile_creeps = _extract_int(final_combat.get("hostileCreeps")) or 0
                    if hostile_creeps > 0:
                        final_combat["hostileCreeps"] = max(0, hostile_creeps - activation_kills)
    policy_activation: JsonObject = {
        "type": activation.get("type"),
        "strategyVariantId": activation.get("strategyVariantId"),
        "executionAction": activation.get("executionAction"),
        "objectiveSignalSource": activation.get("objectiveSignalSource"),
        "targetRoom": activation.get("targetRoom"),
        "hostileKills": hostile_kills,
        "hostileKillsSource": evidence_source,
        "safety": copy.deepcopy(safety),
    }
    if evidence_source == "projectedEvidence":
        policy_activation["projectedHostileKills"] = activation_kills
    else:
        policy_activation["observedHostileKills"] = activation_kills
    projected["policyActivation"] = policy_activation
    return projected


def _tick_fixture_merged_rooms(tick_entry: JsonObject) -> set[str] | None:
    fixture_state = tick_entry.get("fixtureRoomState")
    if not isinstance(fixture_state, dict):
        sources = tick_entry.get("roomStateSources")
        if isinstance(sources, list) and "map-fixture" in sources:
            return None
        return set()
    merged = fixture_state.get("mergedRooms")
    if isinstance(merged, list):
        return {room for room in merged if isinstance(room, str)}
    return None


def _tick_room_is_fixture_generated(tick_entry: JsonObject, room_name: str) -> bool:
    merged = _tick_fixture_merged_rooms(tick_entry)
    if merged is None:
        return True
    return room_name in merged


def _tick_log_has_fixture_generated_rooms(tick_log: Sequence[JsonObject]) -> bool:
    for tick_entry in tick_log:
        if not isinstance(tick_entry, dict):
            continue
        merged = _tick_fixture_merged_rooms(tick_entry)
        if merged is None or merged:
            return True
    return False


def _tick_room_summary(tick_entry: JsonObject, room_name: str) -> JsonObject | None:
    rooms = tick_entry.get("rooms")
    if not isinstance(rooms, dict):
        return None
    summary = rooms.get(room_name)
    return summary if isinstance(summary, dict) else None


def _room_own_presence_count(summary: JsonObject) -> int:
    return (_extract_int(summary.get("ownedCreeps")) or 0) + (_extract_int(summary.get("ownStructures")) or 0)


def _multi_tier_policy_activation_observed_evidence(
    tick_log: Sequence[JsonObject],
    target_room: str,
) -> JsonObject | None:
    snapshots: list[tuple[int | None, JsonObject]] = []
    for tick_entry in tick_log:
        if not isinstance(tick_entry, dict):
            continue
        if _tick_room_is_fixture_generated(tick_entry, target_room):
            continue
        summary = _tick_room_summary(tick_entry, target_room)
        if summary is None or not _room_summary_has_observable_state(summary):
            continue
        tick_value = _extract_int(tick_entry.get("tick"))
        snapshots.append((tick_value, summary))
    if len(snapshots) < 2:
        return None

    initial_tick, initial_summary = snapshots[0]
    final_tick, final_summary = snapshots[-1]
    initial_hostiles = _fixture_room_hostile_count(initial_summary)
    final_hostiles = _fixture_room_hostile_count(final_summary)
    initial_owned = _room_summary_owned(initial_summary)
    final_owned = _room_summary_owned(final_summary)
    initial_own_presence = _room_own_presence_count(initial_summary)
    final_own_presence = _room_own_presence_count(final_summary)
    hostile_reduced = final_hostiles < initial_hostiles
    controller_claimed = not initial_owned and final_owned
    own_presence_increased = final_own_presence > initial_own_presence
    if not (hostile_reduced or controller_claimed or own_presence_increased):
        return None

    return {
        "targetRoom": target_room,
        "observedTickCount": len(snapshots),
        "initialTick": initial_tick,
        "finalTick": final_tick,
        "initialHostileCount": initial_hostiles,
        "finalHostileCount": final_hostiles,
        "hostileCountReduced": hostile_reduced,
        "controllerClaimed": controller_claimed,
        "ownPresenceIncreased": own_presence_increased,
        "fixtureGeneratedRoomState": False,
    }


def build_variant_owned_room_scorecard(variant_result: JsonObject) -> JsonObject:
    tick_log = variant_result.get("tick_log", variant_result.get("tickLog"))
    ticks = [tick for tick in tick_log if isinstance(tick, dict)] if isinstance(tick_log, list) else []
    final_tick = ticks[-1] if ticks else {}
    rooms = final_tick.get("rooms") if isinstance(final_tick, dict) else {}
    room_cards: list[JsonObject] = []
    if isinstance(rooms, dict):
        for room_name, summary in sorted(rooms.items()):
            if not isinstance(room_name, str) or not isinstance(summary, dict):
                continue
            room_card = _room_scorecard_from_summary(room_name, summary)
            if room_card is not None:
                room_cards.append(room_card)
    return {
        "type": OWNED_ROOM_SCORECARD_TYPE,
        "variantId": variant_result.get("variant_id", variant_result.get("variantId")),
        "variantRunId": variant_result.get("variant_run_id", variant_result.get("variantRunId")),
        "tick": final_tick.get("tick") if isinstance(final_tick, dict) else None,
        "ownedRoomCount": len(room_cards),
        "ownedRooms": room_cards,
        "ownStructures": sum(_extract_int(room.get("ownStructures")) or 0 for room in room_cards),
        "ownCreeps": sum(_extract_int(room.get("ownCreeps")) or 0 for room in room_cards),
        "storedEnergy": sum(_extract_int(room.get("storedEnergy")) or 0 for room in room_cards),
        "energyCapacity": sum(_extract_int(room.get("energyCapacity")) or 0 for room in room_cards),
    }


def build_run_owned_room_scorecard(run_id: str, variant_results: Sequence[JsonObject]) -> JsonObject:
    variant_cards: list[JsonObject] = []
    merged_rooms: dict[str, JsonObject] = {}
    for variant in variant_results:
        if not isinstance(variant, dict):
            continue
        variant_card = variant.get("ownedRoomScorecard")
        if not isinstance(variant_card, dict):
            variant_card = build_variant_owned_room_scorecard(variant)
        variant_cards.append(variant_card)
        for room in variant_card.get("ownedRooms", []):
            if not isinstance(room, dict):
                continue
            room_name = text_or_none(room.get("roomName")) or text_or_none(room.get("room"))
            if not room_name:
                continue
            existing = merged_rooms.get(room_name)
            existing_weight = (
                (_extract_int(existing.get("ownStructures")) or 0) + (_extract_int(existing.get("ownCreeps")) or 0)
                if isinstance(existing, dict)
                else -1
            )
            candidate_weight = (_extract_int(room.get("ownStructures")) or 0) + (_extract_int(room.get("ownCreeps")) or 0)
            if existing is None or candidate_weight >= existing_weight:
                merged_rooms[room_name] = dict(room)
    owned_rooms = [merged_rooms[room_name] for room_name in sorted(merged_rooms)]
    return {
        "type": OWNED_ROOM_SCORECARD_TYPE,
        "runId": run_id,
        "ownedRoomCount": len(owned_rooms),
        "ownedRooms": owned_rooms,
        "ownStructures": sum(_extract_int(room.get("ownStructures")) or 0 for room in owned_rooms),
        "ownCreeps": sum(_extract_int(room.get("ownCreeps")) or 0 for room in owned_rooms),
        "storedEnergy": sum(_extract_int(room.get("storedEnergy")) or 0 for room in owned_rooms),
        "energyCapacity": sum(_extract_int(room.get("energyCapacity")) or 0 for room in owned_rooms),
        "variants": variant_cards,
    }


def _dedupe_room_names(room_names: Sequence[str]) -> list[str]:
    ordered: list[str] = []
    for room_name in room_names:
        if isinstance(room_name, str) and room_name not in ordered:
            ordered.append(room_name)
    return ordered


def _visible_room_names(overview: Any, shard: str, anchor_room: str) -> list[str]:
    ordered: list[str] = []
    for room_name in runtime_monitor.overview_rooms(overview, shard):
        if room_name not in ordered:
            ordered.append(room_name)
    if isinstance(overview, dict):
        for room_name in overview.get("rooms") or []:
            if isinstance(room_name, str) and room_name not in ordered:
                ordered.append(room_name)
    if anchor_room not in ordered:
        ordered.insert(0, anchor_room)
    return ordered


def _room_overview_payloads(room_overviews: Any, room_names: Sequence[str], anchor_room: str) -> dict[str, Any]:
    if not isinstance(room_overviews, dict):
        return {}
    if any(isinstance(room_overviews.get(room_name), dict) for room_name in room_names):
        return {
            room_name: payload
            for room_name, payload in room_overviews.items()
            if isinstance(room_name, str) and isinstance(payload, dict)
        }
    return {anchor_room: room_overviews}


def _exception_headers(exc: BaseException) -> dict[str, str] | None:
    for source in (exc, getattr(exc, "response", None), getattr(exc, "result", None)):
        headers = getattr(source, "headers", None)
        if isinstance(headers, dict):
            return {str(key): str(value) for key, value in headers.items()}
        if hasattr(headers, "items"):
            return {str(key): str(value) for key, value in headers.items()}
    return None


def _wait_for_http_with_smoke(cfg: Any, smoke: Any, timeout_seconds: int = RUN_PHASE_TIMEOUT_SECONDS) -> None:
    smoke.wait_for_http(cfg, timeout=timeout_seconds)


def _read_gametime_from_overview(payload: Any, shard: str) -> int | None:
    gametime = runtime_monitor.gametime_from_overview(payload, shard)
    if isinstance(gametime, str):
        return _coerce_int(gametime)
    if isinstance(gametime, int):
        return gametime
    if isinstance(payload, dict):
        flat_gametime = payload.get("gametime")
        if isinstance(flat_gametime, str):
            return _coerce_int(flat_gametime)
        if isinstance(flat_gametime, int):
            return flat_gametime
        flat_gametimes = payload.get("gametimes")
        if isinstance(flat_gametimes, list) and flat_gametimes:
            first_gametime = flat_gametimes[0]
            if isinstance(first_gametime, str):
                return _coerce_int(first_gametime)
            if isinstance(first_gametime, int):
                return first_gametime
    return None


def _read_gametime_from_stats(payload: Any) -> int | None:
    if not isinstance(payload, dict):
        return None
    gametime = payload.get("gametime")
    if isinstance(gametime, str):
        return _coerce_int(gametime)
    if isinstance(gametime, int):
        return gametime
    return None


def _read_current_gametime(
    cfg: Any,
    smoke: Any,
    token: str,
    shard: str,
    overview_payload: Any,
) -> tuple[str, int | None]:
    """Read the freshest game time, preferring /stats over stale private overview clocks."""
    overview_tick = _read_gametime_from_overview(overview_payload, shard)
    stats_tick: int | None = None
    try:
        stats_result = smoke.http_json(
            "GET",
            cfg.server_url,
            "/stats",
            headers=smoke.token_headers(token),
            timeout=RUN_API_TIMEOUT_SECONDS,
        )
        token = smoke.update_token_from_headers(token, stats_result.headers)
        stats_tick = _read_gametime_from_stats(stats_result.payload)
    except Exception:
        stats_tick = None
    return token, stats_tick if stats_tick is not None else overview_tick


def _safe_redact_smoke_payload(payload: Any) -> JsonObject:
    return {"ok": True, "payload": dataset_export.redact_text(json.dumps(payload, sort_keys=True, ensure_ascii=True))[:2000]}


def _fetch_room_overviews(
    cfg: Any,
    smoke: Any,
    token: str,
    rooms: Sequence[str],
    shard: str,
    optional_rooms: Sequence[str] = (),
) -> tuple[str, dict[str, Any]]:
    payloads: dict[str, Any] = {}
    required = set(rooms)
    for room_name in _dedupe_room_names([*rooms, *optional_rooms]):
        try:
            room_overview = smoke.http_json(
                "GET",
                cfg.server_url,
                "/api/game/room-overview",
                params={"room": room_name, "shard": shard},
                headers=smoke.token_headers(token),
                timeout=RUN_API_TIMEOUT_SECONDS,
            )
            token = smoke.update_token_from_headers(token, room_overview.headers)
            if isinstance(room_overview.payload, dict) and not smoke.api_dict_succeeded(room_overview):
                if room_name not in required:
                    continue
                raise RuntimeError(
                    f"/api/game/room-overview returned unusable payload for {room_name}: "
                    f"{_safe_redact_smoke_payload(room_overview.payload)}"
                )
            payloads[room_name] = room_overview.payload
        except Exception as exc:
            headers = _exception_headers(exc)
            if headers is not None:
                token = smoke.update_token_from_headers(token, headers)
            if room_name in required:
                raise
            continue
    return token, payloads


def _run_one_tick(
    cfg: Any,
    smoke: Any,
    token: str,
    room: str,
    shard: str,
    previous_tick: int | None,
    timeout_seconds: float,
    fixture_room_names: Sequence[str] = (),
    fixture_room_summaries: dict[str, JsonObject] | None = None,
) -> tuple[str, int | None, JsonObject]:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        overview_result = smoke.http_json("GET", cfg.server_url, "/api/user/overview", headers=smoke.token_headers(token), timeout=RUN_API_TIMEOUT_SECONDS)
        token = smoke.update_token_from_headers(token, overview_result.headers)
        terrain_result = smoke.http_json(
            "GET",
            cfg.server_url,
            "/api/game/room-terrain",
            params={"room": room, "shard": shard, "encoded": "1"},
            headers=smoke.token_headers(token),
            timeout=RUN_API_TIMEOUT_SECONDS,
        )
        token = smoke.update_token_from_headers(token, terrain_result.headers)
        token, current_tick = _read_current_gametime(cfg, smoke, token, shard, overview_result.payload)
        if isinstance(overview_result.payload, dict) and not smoke.api_dict_succeeded(overview_result):
            raise RuntimeError(f"/api/user/overview returned unusable payload: {_safe_redact_smoke_payload(overview_result.payload)}")
        if current_tick is None:
            time.sleep(RUN_TICK_POLL_SECONDS)
            continue
        if previous_tick is None or current_tick > previous_tick:
            visible_rooms = _visible_room_names(overview_result.payload, shard, room)
            scenario_rooms = [fixture_room for fixture_room in fixture_room_names if fixture_room not in visible_rooms]
            tick_rooms = _dedupe_room_names([*visible_rooms, *scenario_rooms])
            token, room_overviews = _fetch_room_overviews(
                cfg,
                smoke,
                token,
                visible_rooms,
                shard,
                optional_rooms=scenario_rooms,
            )
            tick_entry = _build_tick_entry(
                shard,
                room,
                current_tick,
                overview_result.payload,
                terrain_result.payload,
                room_overviews,
                tick_rooms,
            )
            if fixture_room_summaries:
                _merge_fixture_room_summaries_into_tick(tick_entry, fixture_room_summaries)
            return token, current_tick, tick_entry
        time.sleep(RUN_TICK_POLL_SECONDS)
    raise RuntimeError(f"timed out waiting for tick progression after {timeout_seconds}s")


def _run_variant(
    worker_index: int,
    variant_id: str,
    *,
    run_id: str,
    worker_count: int = 1,
    host_port_start: int = RUN_HTTP_START,
    ticks: int,
    room: str,
    shard: str,
    branch: str,
    code_path: Path,
    map_source_file: Path,
    out_dir: Path,
    variant_configs: Mapping[str, JsonObject] | None = None,
) -> JsonObject:
    api_branch = normalize_private_server_code_branch(branch)
    strategy_variant = strategy_variant_config_by_id(variant_id, variant_configs=variant_configs)
    runtime_parameter_injection = runtime_parameter_injection_for_variant(variant_id, strategy_variant)
    variant_slug = _safe_filename(variant_id)
    worker_run_id = f"{run_id}-{variant_slug}"
    safe_run_root = _worker_output_dir(out_dir, run_id, worker_index)
    server_host = "127.0.0.1"
    http_port: int | None = None
    cli_port: int | None = None
    smoke: Any | None = None
    cfg: Any | None = None
    errors: list[str] = []
    start = time.time()
    token: str | None = None
    variant_ticks: list[JsonObject] = []
    terrain_ready: JsonObject | None = None
    repair_mod_path: Path | None = None
    mongo_room_evidence: JsonObject | None = None
    evidence_errors: list[str] = []
    runtime_parameter_consumption: JsonObject | None = None
    launcher_auto_map_import_disabled = False
    scenario_map_source_file = map_source_file
    fixture_room_summaries: dict[str, JsonObject] = {}
    fixture_room_names: list[str] = []
    compose: list[str] | None = None
    uploaded_code_text: str | None = None
    try:
        smoke = _load_private_smoke_module()
        summarize_prepared_map = _is_default_map_source_file(map_source_file)
        smoke_map_source_file = _resolve_smoke_map_source_file(map_source_file)
        smoke_map_url = str(getattr(smoke, "DEFAULT_MAP_URL", "")) if smoke_map_source_file is None else ""
        http_port, cli_port = _select_run_ports(
            smoke,
            server_host,
            worker_index=worker_index,
            worker_count=worker_count,
            host_port_start=host_port_start,
        )
        compose_project = _safe_compose_project_name(f"{RUN_WORKER_PREFIX}-{_safe_filename(run_id)}-{worker_index:02d}")
        password = secrets.token_urlsafe(20)
        cfg = smoke.SmokeConfig(
            work_dir=safe_run_root,
            server_host=server_host,
            http_port=http_port,
            cli_port=cli_port,
            server_url=f"http://{server_host}:{http_port}",
            username=f"rl-sim-{variant_slug}",
            email=f"{variant_slug}@sim.local",
            password=password,
            room=room,
            shard=shard,
            spawn_name="Spawn1",
            spawn_x=DEFAULT_SPAWN_X,
            spawn_y=DEFAULT_SPAWN_Y,
            branch=api_branch,
            code_path=code_path,
            map_url=smoke_map_url,
            map_source_file=smoke_map_source_file,
            stats_timeout=30,
            poll_interval=1,
            min_creeps=1,
            reset_data=True,
            dry_run=False,
            compose_project=compose_project,
            mongo_db="screeps",
        )
        for error in smoke.required_env_errors(cfg):
            raise RuntimeError(error)
        smoke.assert_safe_work_dir(cfg.work_dir)
        if not code_path.is_file():
            raise RuntimeError(f"code path is not a file: {code_path}")
        preflight = smoke.preflight_host_ports(cfg)
        if preflight.get("checks") and not preflight["checks"]:
            raise RuntimeError("port preflight returned empty checks")
        compose = smoke.find_compose_command()
        smoke.prepare_work_dir(cfg)
        launcher_auto_map_import_disabled = _disable_launcher_auto_map_import(smoke, cfg)
        _debug_worker_phase(
            worker_index,
            variant_id,
            "after _disable_launcher_auto_map_import",
            disabled=launcher_auto_map_import_disabled,
        )
        repair_mod_path = _install_simulator_repair_mod(smoke, cfg)
        _debug_worker_phase(
            worker_index,
            variant_id,
            "after _install_simulator_repair_mod",
            mod_path=repair_mod_path,
        )
        smoke.prepare_map(cfg)
        if summarize_prepared_map:
            scenario_map_source_file = cfg.map_path
        else:
            scenario_map_source_file = smoke_map_source_file or cfg.map_path
        fixture_room_summaries = _private_map_fixture_room_summaries(scenario_map_source_file)
        fixture_room_names = list(fixture_room_summaries)
        _debug_worker_phase(worker_index, variant_id, "after prepare_map", map_path=str(scenario_map_source_file))

        # Reset server-owned state by removing any leftover stack and volumes first.
        _debug_worker_phase(worker_index, variant_id, "before docker compose down", command="down -v")
        down_result = _require_command_success(
            smoke,
            smoke.run_command([*compose, "down", "-v"], cfg, timeout=RUN_CONTAINER_DOWN_TIMEOUT_SECONDS),
            "docker compose down",
        )
        _debug_worker_phase(
            worker_index,
            variant_id,
            "after docker compose down",
            returncode=down_result.get("returncode"),
            elapsed_seconds=down_result.get("elapsed_seconds"),
        )
        _debug_worker_phase(worker_index, variant_id, "before docker compose up", command="up -d")
        up_result = _require_command_success(
            smoke,
            smoke.run_command([*compose, "up", "-d"], cfg, timeout=RUN_CONTAINER_UP_TIMEOUT_SECONDS),
            "docker compose up",
        )
        _debug_worker_phase(
            worker_index,
            variant_id,
            "after docker compose up",
            returncode=up_result.get("returncode"),
            elapsed_seconds=up_result.get("elapsed_seconds"),
        )
        _wait_for_http_with_smoke(cfg, smoke, timeout_seconds=RUN_CONTAINER_UP_TIMEOUT_SECONDS)
        _require_launcher_cli_success(smoke, compose, cfg, "system.resetAllData()", "reset simulator data")
        _require_launcher_cli_success(
            smoke,
            compose,
            cfg,
            "utils.importMapFile('/screeps/maps/map-0b6758af.json')",
            "import simulator map",
        )
        restart_result = _require_command_success(
            smoke,
            smoke.run_command([*compose, "restart", "screeps"], cfg, timeout=RUN_CONTAINER_RESTART_TIMEOUT_SECONDS),
            "docker compose restart screeps",
        )
        _debug_worker_phase(
            worker_index,
            variant_id,
            "after docker compose restart screeps",
            returncode=restart_result.get("returncode"),
            elapsed_seconds=restart_result.get("elapsed_seconds"),
        )
        _wait_for_http_with_smoke(cfg, smoke, timeout_seconds=RUN_CONTAINER_UP_TIMEOUT_SECONDS)
        terrain_ready = _wait_for_terrain_ready(cfg, smoke, room=room, shard=shard)

        register = smoke.http_json(
            "POST",
            cfg.server_url,
            "/api/register/submit",
            smoke.build_register_payload(cfg),
            timeout=RUN_PHASE_TIMEOUT_SECONDS,
        )
        if not smoke.api_dict_succeeded(register):
            raise RuntimeError(f"register failed: {_safe_redact_smoke_payload(register.payload)}")
        signin = smoke.http_json(
            "POST",
            cfg.server_url,
            "/api/auth/signin",
            smoke.build_signin_payload(cfg),
            timeout=RUN_PHASE_TIMEOUT_SECONDS,
        )
        if signin.status != 200:
            raise RuntimeError("signin response was not successful")
        if not isinstance(signin.payload, dict):
            raise RuntimeError("signin response payload was not JSON")
        token = signin.payload.get("token")
        if not isinstance(token, str) or not token:
            raise RuntimeError("signin response did not include an auth token")

        code_text = code_path.read_text(encoding="utf-8")
        uploaded_code_text = apply_runtime_parameter_injection_to_code(code_text, runtime_parameter_injection)
        upload_payload = smoke.build_code_payload(cfg, uploaded_code_text)
        upload_payload["branch"] = api_branch
        upload = smoke.http_json(
            "POST",
            cfg.server_url,
            "/api/user/code",
            upload_payload,
            headers=smoke.token_headers(token),
            timeout=RUN_PHASE_TIMEOUT_SECONDS,
        )
        token = smoke.update_token_from_headers(token, upload.headers)
        if not smoke.upload_code_succeeded(upload):
            raise RuntimeError(
                "code upload failed: "
                f"{_safe_redact_smoke_payload({'status': upload.status, 'payload': upload.payload})}"
            )
        runtime_parameter_injection = mark_runtime_parameter_injection_uploaded(
            runtime_parameter_injection,
            code_text=uploaded_code_text,
        )
        write_json_atomic(safe_run_root / "runtime_parameter_injection.json", runtime_parameter_injection)

        place = smoke.http_json(
            "POST",
            cfg.server_url,
            "/api/game/place-spawn",
            smoke.build_spawn_payload(cfg),
            headers=smoke.token_headers(token),
            timeout=RUN_PHASE_TIMEOUT_SECONDS,
        )
        if not isinstance(place.payload, dict) or not (place.payload.get("ok") == 1):
            place_payload = _safe_redact_smoke_payload(place.payload)
            if "already playing" not in str(place.payload.get("error", "")).lower():
                raise RuntimeError(f"place-spawn API rejected with unexpected payload: {place_payload}")

        initial_state = smoke.http_json(
            "GET",
            cfg.server_url,
            "/api/user/overview",
            headers=smoke.token_headers(token),
            timeout=RUN_PHASE_TIMEOUT_SECONDS,
        )
        token = smoke.update_token_from_headers(token, initial_state.headers)
        token, previous_tick = _read_current_gametime(cfg, smoke, token, shard, initial_state.payload)
        _require_launcher_cli_success(smoke, compose, cfg, "system.resumeSimulation()", "resume simulator")

        for _ in range(ticks):
            token, observed_tick, tick_entry = _run_one_tick(
                cfg,
                smoke,
                token,
                room,
                shard,
                previous_tick,
                timeout_seconds=RUN_TICK_TIMEOUT_SECONDS,
                fixture_room_names=fixture_room_names,
                fixture_room_summaries=fixture_room_summaries,
            )
            previous_tick = observed_tick if observed_tick is not None else previous_tick
            variant_ticks.append(tick_entry)
        if variant_ticks:
            try:
                mongo_room_evidence = _collect_mongo_room_evidence(smoke, compose, cfg)
                if mongo_room_evidence is not None:
                    if not _merge_mongo_room_summary_into_tick(variant_ticks[-1], mongo_room_evidence):
                        evidence_errors.append(
                            f"mongo room evidence failed: {_mongo_room_summary_error(mongo_room_evidence)}"
                        )
            except Exception as exc:  # noqa: BLE001 - HTTP evidence may still be sufficient
                evidence_errors.append(f"mongo room evidence failed: {_safe_text(exc, 360)}")
        if runtime_parameter_injection.get("status") == "injected":
            consumption_evidence, consumption_errors = collect_runtime_parameter_consumption_evidence(
                smoke,
                compose,
                cfg,
                token,
                runtime_parameter_injection,
            )
            evidence_errors.extend(
                f"runtime parameter consumption evidence failed: {error}" for error in consumption_errors
            )
            runtime_parameter_consumption = runtime_parameter_consumption_check(
                runtime_parameter_injection,
                consumption_evidence,
                source_errors=consumption_errors,
            )
            runtime_parameter_injection = apply_runtime_parameter_consumption_to_injection(
                runtime_parameter_injection,
                runtime_parameter_consumption,
            )
            write_json_atomic(safe_run_root / "runtime_parameter_consumption.json", runtime_parameter_consumption)
            write_json_atomic(safe_run_root / "runtime_parameter_injection.json", runtime_parameter_injection)
    except Exception as exc:  # noqa: BLE001 - collect the failure into a safe result
        errors.append(_safe_text(exc, 480))
        runtime_parameter_injection = mark_runtime_parameter_injection_failed(runtime_parameter_injection, exc)
    finally:
        if compose is not None and smoke is not None and cfg is not None:
            try:
                smoke.run_command([*compose, "down", "-v"], cfg, timeout=RUN_CONTAINER_DOWN_TIMEOUT_SECONDS)
            except Exception as exc:  # noqa: BLE001 - preserve the original result and surface cleanup failure
                errors.append(f"cleanup failed: {_safe_text(exc, 420)}")

    wall_seconds = round(time.time() - start, 3)
    if wall_seconds <= 0:
        wall_seconds = 0.0
    ticks_run = len(variant_ticks)
    ticks_per_second = round(ticks_run / wall_seconds, 6) if wall_seconds > 0 else 0.0
    if runtime_parameter_consumption is None:
        runtime_parameter_consumption = runtime_parameter_consumption_check(runtime_parameter_injection, None)
        runtime_parameter_injection = apply_runtime_parameter_consumption_to_injection(
            runtime_parameter_injection,
            runtime_parameter_consumption,
        )
    scenario_code_text = runtime_parameter_injection_uploaded_code_text(
        uploaded_code_text,
        runtime_parameter_injection,
    )
    result = {
        "variant_id": variant_id,
        "variant_run_id": worker_run_id,
        "worker_id": worker_index,
        "strategyVariant": strategy_variant,
        "strategy_variant": strategy_variant,
        "scenario": _safe_build_scenario_config(
            worker_run_id,
            variant_id,
            room=room,
            shard=shard,
            branch=api_branch,
            ticks=ticks,
            code_path=code_path,
            map_source_file=scenario_map_source_file,
            code_payload_text=scenario_code_text,
            runtime_parameter_injection=runtime_parameter_injection,
        ),
        "ticks_requested": ticks,
        "ticks_run": ticks_run,
        "wall_clock_seconds": wall_seconds,
        "ticks_per_second": ticks_per_second,
        "tick_log": variant_ticks,
        "metrics": build_variant_metrics(variant_ticks),
        "policyActivation": None,
        "runtimeParameterInjection": runtime_parameter_injection,
        "runtimeParameterConsumption": runtime_parameter_consumption,
        "live_effect": False,
        "official_mmo_writes": False,
        "ok": False,
        "error": None,
        "errors": errors,
        "evidenceErrors": evidence_errors,
        "serverHost": cfg.server_host if cfg is not None else server_host,
        "serverPorts": _server_ports_payload(http_port, cli_port),
        "branch": api_branch,
        "requestedBranch": branch,
        "terrainReady": terrain_ready,
        "mongoRoomEvidence": mongo_room_evidence,
        "scenarioFixture": build_scenario_fixture_objective_summary(fixture_room_summaries),
        "launcherRepairMod": str(repair_mod_path) if repair_mod_path is not None else None,
        "launcherAutoMapImportDisabled": launcher_auto_map_import_disabled,
    }
    if runtime_parameter_consumption.get("runtimeParameterConsumption") is True:
        result["evaluatedParameters"] = copy.deepcopy(runtime_parameter_consumption.get("evaluatedParameters", {}))
        result["evaluatedParametersSource"] = "runtime_parameter_consumption"
    result["ownedRoomScorecard"] = build_variant_owned_room_scorecard(result)
    if not errors and ticks_run > 0 and result["ownedRoomScorecard"]["ownedRoomCount"] < 1:
        detail = "; ".join(evidence_errors) if evidence_errors else "no owned controller, spawn, structure, or creep found"
        errors.append(f"owned-room scorecard evidence was empty after {ticks_run} tick(s): {detail}")
        result["errors"] = errors
    result["ok"] = len(errors) == 0
    result["error"] = errors[0] if errors else None
    if result["ok"]:
        result["policyActivation"] = build_multi_tier_policy_activation_evidence(
            variant_ticks,
            strategy_variant,
            fixture_room_summaries,
            anchor_room=room,
            run_errors=errors,
            evidence_errors=evidence_errors,
            allow_offline_projection=True,
        )
        result["metrics"] = project_multi_tier_policy_activation_metrics(
            result["metrics"],
            result["policyActivation"],
        )
    return result


def _run_worker_assignments(
    variants: Sequence[str],
    workers: int,
) -> list[list[int]]:
    if workers <= 0:
        return []
    buckets = [[] for _ in range(min(len(variants), workers))]
    for index, variant_index in enumerate(range(len(variants))):
        buckets[index % len(buckets)].append(variant_index)
    return buckets


def _broken_pipe_retry_run_id(run_id: str, attempt: int) -> str:
    return run_id if attempt == 0 else f"{run_id}-bp-retry-{attempt}"


def _broken_pipe_retry_host_port_start(host_port_start: int, worker_count: int, attempt: int) -> int:
    if worker_count <= 0:
        raise RuntimeError("worker count must be a positive integer")
    retry_host_port_start = host_port_start + (attempt * worker_count * RUN_HTTP_PORT_STEP)
    last_cli_port = retry_host_port_start + ((worker_count - 1) * RUN_HTTP_PORT_STEP) + 1
    if last_cli_port > 65535:
        raise RuntimeError(f"simulator retry host port range exceeds TCP port limit: {last_cli_port}")
    return retry_host_port_start


def _annotate_broken_pipe_recovery(
    result: JsonObject,
    *,
    retry_errors: Sequence[str],
    attempts: int,
) -> JsonObject:
    if not retry_errors:
        return result
    result["brokenPipeRecovery"] = {
        "triggered": True,
        "attempts": attempts,
        "maxRetries": RUN_BROKEN_PIPE_MAX_RETRIES,
        "recovered": result.get("ok") is True,
        "errors": list(retry_errors),
    }
    if result.get("ok") is True:
        result["recoveredErrors"] = list(retry_errors)
    return result


def run_variants(
    *,
    variants: Sequence[str],
    ticks: int,
    workers: int,
    host_port_start: int = RUN_HTTP_START,
    room: str,
    shard: str,
    branch: str,
    code_path: Path,
    map_source_file: Path,
    out_dir: Path,
    run_id: str,
    bot_commit: str | None = None,
    variant_configs: Mapping[str, JsonObject] | None = None,
) -> tuple[JsonObject, list[JsonObject]]:
    if ticks <= 0:
        raise ValueError("ticks must be a positive integer")
    if workers <= 0:
        raise ValueError("workers must be a positive integer")
    if not variants:
        raise ValueError("at least one strategy variant is required")

    start = time.monotonic()
    resolved_bot_commit = resolve_bot_commit(bot_commit)
    normalized_workers = max(1, min(workers, len(variants)))
    buckets = _run_worker_assignments(variants, normalized_workers)
    worker_variants: list[list[str]] = [[variants[index] for index in bucket] for bucket in buckets]
    variant_worker: dict[str, int] = {}
    for worker_id, assigned in enumerate(worker_variants):
        for variant_id in assigned:
            variant_worker[variant_id] = worker_id

    def worker_loop(worker_id: int, assigned_variants: list[str]) -> list[JsonObject]:
        results: list[JsonObject] = []
        for variant_id in assigned_variants:
            variant_start = time.time()
            retry_errors: list[str] = []
            try:
                result: JsonObject | None = None
                attempts_made = 0
                for attempt in range(RUN_BROKEN_PIPE_MAX_RETRIES + 1):
                    attempts_made = attempt + 1
                    attempt_run_id = _broken_pipe_retry_run_id(run_id, attempt)
                    attempt_host_port_start = _broken_pipe_retry_host_port_start(
                        host_port_start,
                        normalized_workers,
                        attempt,
                    )
                    result = _run_variant(
                        worker_index=worker_id,
                        variant_id=variant_id,
                        run_id=attempt_run_id,
                        worker_count=normalized_workers,
                        host_port_start=attempt_host_port_start,
                        ticks=ticks,
                        room=room,
                        shard=shard,
                        branch=branch,
                        code_path=code_path,
                        map_source_file=map_source_file,
                        out_dir=out_dir,
                        variant_configs=variant_configs,
                    )
                    if result.get("ok") is True or not _variant_result_mentions_broken_pipe(result):
                        break
                    retry_errors.append(_safe_text(result.get("error") or result.get("errors"), 480))
                    cleanup_exact_run_worker_containers(attempt_run_id, worker_index=worker_id)
                    if attempt < RUN_BROKEN_PIPE_MAX_RETRIES:
                        time.sleep(RUN_BROKEN_PIPE_RETRY_BACKOFF_SECONDS)
                if result is None:
                    raise RuntimeError("worker did not produce a variant result")
                results.append(
                    _annotate_broken_pipe_recovery(
                        result,
                        retry_errors=retry_errors,
                        attempts=attempts_made,
                    )
                )
            except Exception as exc:  # noqa: BLE001 - keep one result row per requested variant
                results.append(
                    _build_variant_failure_result(
                        variant_id,
                        worker_index=worker_id,
                        run_id=run_id,
                        ticks=ticks,
                        room=room,
                        shard=shard,
                        branch=branch,
                        code_path=code_path,
                        map_source_file=map_source_file,
                        error=f"worker {worker_id} failed while running variant: {_safe_text(exc, 420)}",
                        wall_clock_seconds=time.time() - variant_start,
                        variant_configs=variant_configs,
                    )
                )
        return results

    result_map: dict[str, JsonObject] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=normalized_workers) as executor:
        futures = {}
        for worker_id, assigned in enumerate(worker_variants):
            if not assigned:
                continue
            futures[executor.submit(worker_loop, worker_id, assigned)] = assigned
        for future in concurrent.futures.as_completed(futures):
            assigned = futures[future]
            try:
                worker_results = future.result()
            except Exception as exc:  # noqa: BLE001 - preserve assigned variants in the final summary
                worker_results = [
                    _build_variant_failure_result(
                        variant_id,
                        worker_index=variant_worker.get(variant_id, -1),
                        run_id=run_id,
                        ticks=ticks,
                        room=room,
                        shard=shard,
                        branch=branch,
                        code_path=code_path,
                        map_source_file=map_source_file,
                        error=f"worker failed before result collection: {_safe_text(exc, 420)}",
                        variant_configs=variant_configs,
                    )
                    for variant_id in assigned
                ]
            for item in worker_results:
                variant_id = item.get("variant_id") if isinstance(item, dict) else None
                if isinstance(variant_id, str):
                    result_map[variant_id] = item
    for variant_id in variants:
        if variant_id in result_map:
            continue
        result_map[variant_id] = _build_variant_failure_result(
            variant_id,
            worker_index=variant_worker.get(variant_id, -1),
            run_id=run_id,
            ticks=ticks,
            room=room,
            shard=shard,
            branch=branch,
            code_path=code_path,
            map_source_file=map_source_file,
            error="variant missing from worker result collection",
            variant_configs=variant_configs,
        )
    ordered = [result_map[variant] for variant in variants]
    artifact = build_run_artifact(
        run_id,
        ticks=ticks,
        workers=normalized_workers,
        variant_results=ordered,
        branch=branch,
        bot_commit=resolved_bot_commit,
        wall_clock_seconds=time.monotonic() - start,
    )
    return artifact, ordered


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


def host_port_start_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error
    if parsed < 1 or parsed >= 65535:
        raise argparse.ArgumentTypeError("must be between 1 and 65534")
    return parsed


def resolve_run_host_port_start(cli_value: int | None) -> int:
    if cli_value is not None:
        return cli_value
    env_value = os.environ.get(RUN_HOST_PORT_START_ENV)
    if env_value:
        try:
            return host_port_start_int(env_value)
        except argparse.ArgumentTypeError as error:
            raise RuntimeError(f"{RUN_HOST_PORT_START_ENV} {error}") from error
    return RUN_HTTP_START


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
    repo = repo_root or REPO_ROOT
    resolved_bot_commit = resolve_bot_commit(bot_commit, repo)
    resolved_out_dir = out_dir.expanduser()
    scan = dataset_export.collect_artifact_records(
        paths,
        max_file_bytes=max_file_bytes,
        excluded_roots=[resolved_out_dir],
        excluded_directory_names=HARNESS_EXCLUDED_DIRECTORY_NAMES,
        binary_file_extensions=HARNESS_BINARY_FILE_EXTENSIONS,
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
        "owningIssue": "#879",
        "milestone": "P1: RL strategy flywheel gate",
        "roadmap": {
            "path": "docs/ops/rl-domain-roadmap.md",
            "lane": "L3 Simulator harness",
            "slice": "Slice B - simulator harness design-to-smoke",
        },
        "sourceMode": "local-artifact-metadata-only",
        "botCommit": resolved_bot_commit,
        "scenario": build_scenario_metadata(resolved_manifest_id, seed_material, scan, metadata),
        "strategyVariants": {
            "configuredVariantCount": len(DEFAULT_STRATEGY_VARIANT_CONFIGS),
            "defaultVariantIds": default_strategy_variant_ids(),
            "variants": default_strategy_variant_configs(),
        },
        "adapterContract": adapter_contract(),
        "seed": build_seed_contract(seed, seed_material),
        "reset": build_reset_contract(seed_material),
        "workers": build_worker_contract(workers, rooms_per_worker),
        "throughput": throughput,
        "sources": build_source_metadata(scan, metadata),
        "datasets": metadata["datasets"],
        "simulatorRuns": metadata["simulatorRuns"],
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
        "strategyVariants": default_strategy_variant_configs(),
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
        "strategyVariantCount": len(DEFAULT_STRATEGY_VARIANT_CONFIGS),
        "completedSimulatorRunCount": metadata["simulatorRuns"]["completedRunCount"],
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
        "simulatorRuns": {
            "indexedRunCount": 0,
            "completedRunCount": 0,
            "runs": [],
        },
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
                simulator_run = simulator_run_metadata(item, source, line_number)
                if simulator_run is not None:
                    metadata["simulatorRuns"]["runs"].append(simulator_run)

    for key in metadata["datasets"]:
        metadata["datasets"][key].sort(key=lambda item: metadata_sort_key(item, "runId"))
    metadata["strategyShadowReports"].sort(key=lambda item: metadata_sort_key(item, "reportId"))
    metadata["privateSmokeReports"].sort(key=lambda item: metadata_sort_key(item, "workDir"))
    metadata["simulatorRuns"]["runs"].sort(key=lambda item: metadata_sort_key(item, "runId"))
    metadata["simulatorRuns"]["indexedRunCount"] = len(metadata["simulatorRuns"]["runs"])
    metadata["simulatorRuns"]["completedRunCount"] = sum(
        1 for item in metadata["simulatorRuns"]["runs"] if number_or_none(item.get("completedVariantCount"))
    )
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


def simulator_run_metadata(
    raw: JsonObject,
    source: dataset_export.SourceFile,
    line_number: int | None,
) -> JsonObject | None:
    if raw.get("type") != RUN_SUMMARY_TYPE:
        return None
    variants = raw.get("variants") if isinstance(raw.get("variants"), list) else []
    variant_rows = [variant for variant in variants if isinstance(variant, dict)]
    completed_variant_count = sum(
        1
        for variant in variant_rows
        if variant.get("ok") is True and (_extract_int(variant.get("ticks_run")) or 0) > 0
    )
    failed_variant_count = sum(1 for variant in variant_rows if variant.get("ok") is False)
    return {
        **source_common(source, line_number),
        "runId": text_or_none(raw.get("runId")),
        "botCommit": text_or_none(raw.get("botCommit")),
        "branch": text_or_none(raw.get("branch")),
        "variantCount": len(variant_rows),
        "completedVariantCount": completed_variant_count,
        "failedVariantCount": failed_variant_count,
        "variantIds": string_list([variant.get("variant_id") for variant in variant_rows]),
        "ticksRequested": number_or_none(raw.get("ticksRequested")),
        "workerCount": number_or_none(raw.get("workerCount")),
        "wallClockSeconds": number_or_none(raw.get("wallClockSeconds")),
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
    for item in metadata["simulatorRuns"]["runs"]:
        source_id = item.get("sourceId")
        if isinstance(source_id, str):
            result.setdefault(source_id, set()).add("simulatorRuns")
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
        "strategyVariantCount": manifest["scenario"]["strategyVariantCount"],
        "completedSimulatorRunCount": manifest["scenario"]["completedSimulatorRunCount"],
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


def _non_empty_text(value: Any) -> str | None:
    text = text_or_none(value)
    if text is None:
        return None
    stripped = text.strip()
    return stripped or None


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


def cleanup_exact_run_worker_containers(
    run_id: str,
    *,
    worker_index: int | None = None,
    container_names: Sequence[str] | None = None,
    docker_binary: str | None = None,
    runner: Any | None = None,
) -> JsonObject:
    """Force-remove only Docker containers whose names belong to this run id."""
    names_error: str | None = None
    if container_names is None:
        container_names, names_error = _docker_container_names(all_containers=True, docker_binary=docker_binary)
    matched = _matching_run_worker_container_names(run_id, container_names, worker_index=worker_index)
    docker = docker_binary or _docker_binary_for_guard()
    errors: list[str] = []
    command_summary: list[str] | None = None
    returncode: int | None = None
    output_excerpt: str | None = None
    if names_error:
        errors.append(f"container listing failed: {_safe_text(names_error, 240)}")
    if matched:
        if not docker:
            errors.append("docker command not found for exact-run cleanup")
        else:
            command = [docker, "rm", "-f", *matched]
            command_summary = [Path(command[0]).name, *command[1:]]
            run = runner or subprocess.run
            try:
                result = run(
                    command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=RUN_DOCKER_CLEANUP_TIMEOUT_SECONDS,
                    check=False,
                )
                returncode = _coerce_int(getattr(result, "returncode", None))
                output = "\n".join(
                    part
                    for part in (getattr(result, "stdout", ""), getattr(result, "stderr", ""))
                    if isinstance(part, str) and part
                )
                output_excerpt = _safe_text(output, 500) if output else None
                if returncode not in (None, 0):
                    errors.append(f"docker rm exited {returncode}: {output_excerpt or 'no output'}")
            except (OSError, subprocess.SubprocessError) as exc:
                errors.append(f"docker rm failed: {_safe_text(exc, 240)}")
    return {
        "ok": not errors,
        "runId": run_id,
        "workerIndex": worker_index,
        "targetNamePrefix": (
            f"{_run_worker_project_prefix(run_id)}-{worker_index:02d}-"
            if worker_index is not None and worker_index >= 0
            else f"{_run_worker_project_prefix(run_id)}-"
        ),
        "matchedContainers": matched,
        "removedContainers": matched if matched and not errors else [],
        "command": command_summary,
        "returncode": returncode,
        "outputExcerpt": output_excerpt,
        "errors": errors,
    }


def _build_run_failure_variant_results(
    variants: Sequence[str],
    *,
    run_id: str,
    ticks: int,
    workers: int,
    room: str,
    shard: str,
    branch: str,
    code_path: Path,
    map_source_file: Path,
    error: Any,
    variant_configs: Mapping[str, JsonObject] | None = None,
) -> list[JsonObject]:
    effective_workers = max(1, _effective_run_worker_count(workers, variants))
    results: list[JsonObject] = []
    for index, variant_id in enumerate(variants):
        worker_index = index % effective_workers
        api_branch = normalize_private_server_code_branch(branch)
        variant_slug = _safe_filename(variant_id)
        error_text = _safe_text(error, 480)
        strategy_variant: JsonObject | None = None
        try:
            strategy_variant = strategy_variant_config_by_id(variant_id, variant_configs=variant_configs)
        except Exception:
            strategy_variant = {
                "id": variant_id,
                "label": variant_id,
                "rolloutStatus": "unknown",
                "source": "run failure before variant validation",
            }
        runtime_parameter_injection = mark_runtime_parameter_injection_not_attempted(
            runtime_parameter_injection_for_variant(variant_id, strategy_variant),
            error_text,
        )
        runtime_parameter_consumption = runtime_parameter_consumption_check(runtime_parameter_injection, None)
        result: JsonObject = {
            "variant_id": variant_id,
            "variant_run_id": f"{run_id}-{variant_slug}",
            "worker_id": worker_index,
            "scenario": _safe_build_scenario_config(
                f"{run_id}-{variant_slug}",
                variant_id,
                room=room,
                shard=shard,
                branch=api_branch,
                ticks=ticks,
                code_path=code_path,
                map_source_file=map_source_file,
                runtime_parameter_injection=runtime_parameter_injection,
            ),
            "ticks_requested": ticks,
            "ticks_run": 0,
            "wall_clock_seconds": 0.0,
            "ticks_per_second": 0.0,
            "tick_log": [],
            "metrics": build_variant_metrics([]),
            "live_effect": False,
            "official_mmo_writes": False,
            "ok": False,
            "error": error_text,
            "errors": [error_text],
            "serverHost": "127.0.0.1",
            "serverPorts": {},
            "branch": api_branch,
            "requestedBranch": branch,
            "runtimeParameterInjection": runtime_parameter_injection,
            "runtimeParameterConsumption": runtime_parameter_consumption,
        }
        result["strategyVariant"] = strategy_variant
        result["strategy_variant"] = strategy_variant
        result["ownedRoomScorecard"] = build_variant_owned_room_scorecard(result)
        results.append(result)
    return results


def _run_failure_artifact_identity(phase: str) -> tuple[str, str]:
    if phase == "resource-guard":
        return RUN_RESOURCE_GUARD_FAILURE_TYPE, "resource_guard_failure.json"
    if phase == "required-env":
        return RUN_SETUP_FAILURE_TYPE, "setup_failure.json"
    return RUN_FAILURE_TYPE, "run_failure.json"


def write_run_failure_artifacts(
    *,
    run_id: str,
    out_dir: Path,
    ticks: int,
    workers: int,
    variants: Sequence[str],
    branch: str,
    room: str,
    shard: str,
    code_path: Path,
    map_source_file: Path,
    bot_commit: str | None,
    phase: str,
    error: Any,
    resource_guard: JsonObject | None,
    cleanup: JsonObject | None,
    variant_configs: Mapping[str, JsonObject] | None = None,
) -> JsonObject:
    """Persist a redacted run failure report and a schema-compatible run summary."""
    resolved_error = _safe_text(error, 720)
    variant_results = _build_run_failure_variant_results(
        variants,
        run_id=run_id,
        ticks=ticks,
        workers=workers,
        room=room,
        shard=shard,
        branch=branch,
        code_path=code_path,
        map_source_file=map_source_file,
        error=resolved_error,
        variant_configs=variant_configs,
    )
    run_dir = out_dir / run_id
    run_artifact_path = run_dir / "run_summary.json"
    scorecard_path = run_dir / "owned_room_scorecard.json"
    failure_type, failure_filename = _run_failure_artifact_identity(phase)
    failure_path = run_dir / failure_filename
    artifact = build_run_artifact(
        run_id,
        ticks=ticks,
        workers=_effective_run_worker_count(workers, variants),
        variant_results=variant_results,
        branch=branch,
        bot_commit=bot_commit,
        wall_clock_seconds=0.0,
    )
    artifact["variants"] = variant_results
    artifact["resourceGuard"] = resource_guard
    artifact["cleanup"] = cleanup
    artifact["failurePhase"] = phase
    artifact["failureArtifactPath"] = str(failure_path)
    artifact["ownedRoomScorecard"] = build_run_owned_room_scorecard(run_id, variant_results)
    artifact["ownedRoomScorecardPath"] = str(scorecard_path)
    validate_run_artifact(artifact)
    secret_values = dataset_export.configured_secret_values() + [os.environ.get("STEAM_KEY", "")]
    assert_no_secret_leak(artifact, secret_values)
    report = {
        "type": failure_type,
        "schemaVersion": SCHEMA_VERSION,
        "ok": False,
        "runId": run_id,
        "phase": phase,
        "error": resolved_error,
        "resourceGuard": resource_guard,
        "cleanup": cleanup,
        "safety": safety_metadata(),
    }
    assert_no_secret_leak(report, secret_values)
    write_json_atomic(scorecard_path, artifact["ownedRoomScorecard"])
    write_json_atomic(run_artifact_path, artifact)
    write_json_atomic(failure_path, report)
    artifact["run_artifact_path"] = str(run_artifact_path)
    return artifact


def build_scale_validation_report(
    *,
    run_id: str,
    workers: int,
    variants: Sequence[str],
    allow_unsafe_scale: bool = False,
    min_concurrent_environments: int = RUN_SCALE_VALIDATION_DEFAULT_MIN_ENVIRONMENTS,
    host_snapshot: JsonObject | None = None,
) -> JsonObject:
    """Return a no-Docker scale preflight report for scheduling E2 proof runs."""
    resource_guard = build_resource_guard_decision(
        run_id=run_id,
        workers=workers,
        variants=variants,
        allow_unsafe_scale=allow_unsafe_scale,
        host_snapshot=host_snapshot,
        min_concurrent_environments=min_concurrent_environments,
    )
    return {
        "type": RUN_SCALE_VALIDATION_PLAN_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "ok": resource_guard["ok"],
        "decision": resource_guard["decision"],
        "runId": run_id,
        "workerCount": workers,
        "variantCount": len(variants),
        "variants": list(variants),
        "resourceGuard": resource_guard,
        "scaleValidation": resource_guard["scaleValidation"],
        "safety": safety_metadata(),
    }


def write_scale_validation_report(
    *,
    out_dir: Path,
    run_id: str,
    workers: int,
    variants: Sequence[str],
    allow_unsafe_scale: bool = False,
    min_concurrent_environments: int = RUN_SCALE_VALIDATION_DEFAULT_MIN_ENVIRONMENTS,
) -> JsonObject:
    """Write a deterministic scale preflight report without starting Docker."""
    report = build_scale_validation_report(
        run_id=run_id,
        workers=workers,
        variants=variants,
        allow_unsafe_scale=allow_unsafe_scale,
        min_concurrent_environments=min_concurrent_environments,
    )
    report_path = out_dir.expanduser() / run_id / "scale_validation_plan.json"
    secret_values = dataset_export.configured_secret_values() + [os.environ.get("STEAM_KEY", "")]
    assert_no_secret_leak(report, secret_values)
    write_json_atomic(report_path, report)
    report["planArtifactPath"] = str(report_path)
    return report


def run_simulator(
    *,
    ticks: int,
    workers: int,
    variants: Sequence[str],
    out_dir: Path,
    run_id: str | None = None,
    host_port_start: int = RUN_HTTP_START,
    room: str = DEFAULT_SIM_ROOM,
    shard: str = DEFAULT_SIM_SHARD,
    branch: str = DEFAULT_ACTIVE_WORLD_BRANCH,
    code_path: Path = DEFAULT_CODE_PATH,
    map_source_file: Path = DEFAULT_MAP_SOURCE_FILE,
    bot_commit: str | None = None,
    allow_unsafe_scale: bool = False,
    min_concurrent_environments: int = 0,
    steam_key_env_file: Path | None = None,
    variant_configs: Mapping[str, JsonObject] | None = None,
) -> JsonObject:
    resolved_out_dir = out_dir.expanduser()
    resolved_code_path = code_path.expanduser()
    resolved_map_source = map_source_file.expanduser()
    api_branch = normalize_private_server_code_branch(branch)
    resolved_bot_commit = resolve_bot_commit(bot_commit)
    try:
        resolved_run_id = validate_run_id_token(run_id or f"{RUN_ID_PREFIX}-{int(time.time())}")
    except ValueError as error:
        raise RuntimeError(str(error)) from error
    resource_guard = build_resource_guard_decision(
        run_id=resolved_run_id,
        workers=workers,
        variants=variants,
        allow_unsafe_scale=allow_unsafe_scale,
        min_concurrent_environments=min_concurrent_environments,
    )
    if not resource_guard["ok"]:
        cleanup = cleanup_exact_run_worker_containers(resolved_run_id)
        write_run_failure_artifacts(
            run_id=resolved_run_id,
            out_dir=resolved_out_dir,
            ticks=ticks,
            workers=workers,
            variants=variants,
            branch=api_branch,
            room=room,
            shard=shard,
            code_path=resolved_code_path,
            map_source_file=resolved_map_source,
            bot_commit=resolved_bot_commit,
            phase="resource-guard",
            error="resource guard rejected simulator scale run: " + "; ".join(resource_guard["reasons"]),
            resource_guard=resource_guard,
            cleanup=cleanup,
            variant_configs=variant_configs,
        )
        raise RuntimeError("resource guard rejected simulator scale run: " + "; ".join(resource_guard["reasons"]))
    ensure_steam_key_for_simulator_run(env_file=steam_key_env_file)
    if not os.environ.get("STEAM_KEY", "").strip():
        cleanup = cleanup_exact_run_worker_containers(resolved_run_id)
        write_run_failure_artifacts(
            run_id=resolved_run_id,
            out_dir=resolved_out_dir,
            ticks=ticks,
            workers=workers,
            variants=variants,
            branch=api_branch,
            room=room,
            shard=shard,
            code_path=resolved_code_path,
            map_source_file=resolved_map_source,
            bot_commit=resolved_bot_commit,
            phase="required-env",
            error="STEAM_KEY environment variable is required for run mode",
            resource_guard=resource_guard,
            cleanup=cleanup,
            variant_configs=variant_configs,
        )
        raise RuntimeError("STEAM_KEY environment variable is required for run mode")
    try:
        artifact, variants_result = run_variants(
            variants=variants,
            ticks=ticks,
            workers=workers,
            host_port_start=host_port_start,
            room=room,
            shard=shard,
            branch=api_branch,
            code_path=resolved_code_path,
            map_source_file=resolved_map_source,
            out_dir=resolved_out_dir,
            run_id=resolved_run_id,
            bot_commit=resolved_bot_commit,
            variant_configs=variant_configs,
        )
    except Exception as exc:
        cleanup = cleanup_exact_run_worker_containers(resolved_run_id)
        write_run_failure_artifacts(
            run_id=resolved_run_id,
            out_dir=resolved_out_dir,
            ticks=ticks,
            workers=workers,
            variants=variants,
            branch=api_branch,
            room=room,
            shard=shard,
            code_path=resolved_code_path,
            map_source_file=resolved_map_source,
            bot_commit=resolved_bot_commit,
            phase="run-variants",
            error=exc,
            resource_guard=resource_guard,
            cleanup=cleanup,
            variant_configs=variant_configs,
        )
        raise
    run_artifact_path = resolved_out_dir / resolved_run_id / "run_summary.json"
    scorecard_path = resolved_out_dir / resolved_run_id / "owned_room_scorecard.json"
    artifact["variants"] = variants_result
    artifact["resourceGuard"] = resource_guard
    _apply_run_summary_fields(artifact, variants_result)
    artifact["ownedRoomScorecard"] = build_run_owned_room_scorecard(resolved_run_id, variants_result)
    artifact["ownedRoomScorecardPath"] = str(scorecard_path)
    validate_run_artifact(artifact)
    assert_no_secret_leak(artifact, dataset_export.configured_secret_values() + [os.environ.get("STEAM_KEY", "")])
    write_json_atomic(scorecard_path, artifact["ownedRoomScorecard"])
    write_json_atomic(run_artifact_path, artifact)
    artifact["run_artifact_path"] = str(run_artifact_path)
    return artifact


def ensure_steam_key_for_simulator_run(env_file: Path | None = None) -> None:
    """Load STEAM_KEY from the local secret env file before the simulator required-env gate."""
    screeps_secret_env.ensure_env_value_from_file(
        "STEAM_KEY",
        env_file=env_file,
        override_env_var=STEAM_KEY_ENV_FILE_ENV,
        default_env_file=DEFAULT_STEAM_KEY_ENV_FILE,
    )


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
    dry.add_argument(
        "--bot-commit",
        default=None,
        help=f"Bot commit to record. Default: auto-detect git HEAD, then {DEFAULT_BOT_COMMIT}.",
    )
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

    run = subparsers.add_parser(
        "run",
        help="Run Docker private-server variants and collect tick-level metrics.",
    )
    run.add_argument(
        "--run-id",
        type=parse_run_id_token,
        default=None,
        help="Optional run artifact id. Defaults to a timestamped rl-sim-run value.",
    )
    run.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_RUN_OUT_DIR,
        help=f"Run output root. Default: {DEFAULT_RUN_OUT_DIR}.",
    )
    run.add_argument(
        "--variants",
        action="append",
        default=[],
        help=(
            "Comma-separated strategy variants. Defaults to construction-priority incumbent and "
            "container-prioritized shadow. Repeatable."
        ),
    )
    run.add_argument(
        "--scale-environments",
        type=positive_int,
        default=None,
        help=(
            "Expand selected base variants into this many unique simulator environment rows for scale "
            "validation. Useful for proving 5 concurrent environments with fewer distinct strategies."
        ),
    )
    run.add_argument(
        "--min-concurrent-environments",
        type=positive_int,
        default=None,
        help=(
            "Require at least this many effective concurrent simulator environment rows before Docker startup. "
            "Defaults to --scale-environments when that option is set."
        ),
    )
    run.add_argument(
        "--bot-commit",
        default=None,
        help=f"Bot bundle commit recorded in run artifacts. Default: auto-detect git HEAD, then {DEFAULT_BOT_COMMIT}.",
    )
    run.add_argument(
        "--host-port-start",
        type=host_port_start_int,
        default=None,
        help=(
            "Starting host HTTP port for worker private-server stacks. "
            f"Default: ${RUN_HOST_PORT_START_ENV}, then {RUN_HTTP_START}."
        ),
    )
    run.add_argument(
        "--ticks",
        type=positive_int,
        default=DEFAULT_RUN_TICKS,
        help=f"Ticks per variant. Default: {DEFAULT_RUN_TICKS}.",
    )
    run.add_argument(
        "--workers",
        type=positive_int,
        default=DEFAULT_RUN_WORKERS,
        help=f"Parallel simulator workers. Default: {DEFAULT_RUN_WORKERS}.",
    )
    run.add_argument(
        "--allow-unsafe-scale",
        action="store_true",
        help=(
            "Allow a run that the resource guard would otherwise reject. "
            f"Equivalent env override: {RUN_RESOURCE_GUARD_ALLOW_UNSAFE_ENV}=1."
        ),
    )
    run.add_argument(
        "--room",
        default=DEFAULT_SIM_ROOM,
        help=f"Target room for reset + spawn. Default: {DEFAULT_SIM_ROOM}.",
    )
    run.add_argument(
        "--shard",
        default=DEFAULT_SIM_SHARD,
        help=f"Target shard. Default: {DEFAULT_SIM_SHARD}.",
    )
    run.add_argument(
        "--branch",
        default=DEFAULT_ACTIVE_WORLD_BRANCH,
        help=(
            "Code branch for /api/user/code. Private-server active aliases activeWorld/activeSim are "
            f"normalized to $activeWorld/$activeSim. Default: {DEFAULT_ACTIVE_WORLD_BRANCH}."
        ),
    )
    run.add_argument(
        "--code-path",
        type=Path,
        default=DEFAULT_CODE_PATH,
        help=f"Bot bundle path. Default: {DEFAULT_CODE_PATH}.",
    )
    run.add_argument(
        "--map-source-file",
        type=Path,
        default=DEFAULT_MAP_SOURCE_FILE,
        help=f"Map source JSON path. Default: {DEFAULT_MAP_SOURCE_FILE}.",
    )
    run.add_argument(
        "--steam-key-env-file",
        type=Path,
        default=None,
        help=(
            "Optional env file to load STEAM_KEY from when it is absent. "
            f"Defaults to {DEFAULT_STEAM_KEY_ENV_FILE}; env override: {STEAM_KEY_ENV_FILE_ENV}."
        ),
    )

    plan_scale = subparsers.add_parser(
        "plan-scale",
        help="Preflight an E2 scale-validation run without starting Docker or requiring secrets.",
    )
    plan_scale.add_argument(
        "--run-id",
        type=parse_run_id_token,
        default="rl-e2-scale-plan",
        help="Plan artifact id. Default: rl-e2-scale-plan.",
    )
    plan_scale.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_RUN_OUT_DIR,
        help=f"Plan output root. Default: {DEFAULT_RUN_OUT_DIR}.",
    )
    plan_scale.add_argument(
        "--variants",
        action="append",
        default=[],
        help=(
            "Comma-separated base strategy variants. Defaults to construction-priority incumbent and "
            "container-prioritized shadow. Repeatable."
        ),
    )
    plan_scale.add_argument(
        "--scale-environments",
        type=positive_int,
        default=RUN_SCALE_VALIDATION_DEFAULT_MIN_ENVIRONMENTS,
        help=(
            "Number of unique simulator environment rows to plan. "
            f"Default: {RUN_SCALE_VALIDATION_DEFAULT_MIN_ENVIRONMENTS}."
        ),
    )
    plan_scale.add_argument(
        "--min-concurrent-environments",
        type=positive_int,
        default=RUN_SCALE_VALIDATION_DEFAULT_MIN_ENVIRONMENTS,
        help=(
            "Minimum effective concurrent environments required for the plan. "
            f"Default: {RUN_SCALE_VALIDATION_DEFAULT_MIN_ENVIRONMENTS}."
        ),
    )
    plan_scale.add_argument(
        "--workers",
        type=positive_int,
        default=RUN_SCALE_VALIDATION_DEFAULT_MIN_ENVIRONMENTS,
        help=f"Parallel simulator workers to plan. Default: {RUN_SCALE_VALIDATION_DEFAULT_MIN_ENVIRONMENTS}.",
    )
    plan_scale.add_argument(
        "--allow-unsafe-scale",
        action="store_true",
        help=(
            "Record the unsafe-scale override in the plan. "
            f"Equivalent env override: {RUN_RESOURCE_GUARD_ALLOW_UNSAFE_ENV}=1."
        ),
    )
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
    if args.command == "run":
        if not hasattr(args, "variants"):
            raise RuntimeError("run command requires --variants or no-argument default to registry")
        variants = normalize_variants(args.variants, available_strategy_variants(discover_strategy_variants()))
        variants = expand_scale_environment_variants(variants, args.scale_environments)
        min_concurrent_environments = args.min_concurrent_environments or args.scale_environments or 0
        summary = run_simulator(
            ticks=args.ticks,
            workers=args.workers,
            variants=variants,
            out_dir=args.out_dir,
            run_id=args.run_id,
            host_port_start=resolve_run_host_port_start(args.host_port_start),
            room=args.room,
            shard=args.shard,
            branch=args.branch,
            code_path=args.code_path,
            map_source_file=args.map_source_file,
            bot_commit=args.bot_commit,
            allow_unsafe_scale=args.allow_unsafe_scale,
            min_concurrent_environments=min_concurrent_environments,
            steam_key_env_file=args.steam_key_env_file,
        )
        stdout.write(json.dumps(summary, indent=2, sort_keys=True, ensure_ascii=True))
        stdout.write("\n")
        variant_results = summary.get("variants")
        if not isinstance(variant_results, list):
            return 1
        overall_ok = all(isinstance(variant, dict) and variant.get("ok", False) for variant in variant_results)
        return 0 if overall_ok else 1
    if args.command == "plan-scale":
        variants = normalize_variants(args.variants, available_strategy_variants(discover_strategy_variants()))
        variants = expand_scale_environment_variants(variants, args.scale_environments)
        report = write_scale_validation_report(
            out_dir=args.out_dir,
            run_id=args.run_id,
            workers=args.workers,
            variants=variants,
            allow_unsafe_scale=args.allow_unsafe_scale,
            min_concurrent_environments=args.min_concurrent_environments,
        )
        stdout.write(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=True))
        stdout.write("\n")
        return 0 if report.get("decision") == "allowed" else 1
    raise AssertionError(f"unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
