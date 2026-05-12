#!/usr/bin/env python3
"""Ingest local Screeps gameplay/RL artifacts into a SQLite metrics store."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path


DEFAULT_DB_PATH = Path("runtime-artifacts/rl-metrics/rl_metrics.sqlite")
DEFAULT_ARTIFACT_ROOTS = (
    Path("runtime-artifacts/runtime-summary-console"),
    Path("runtime-artifacts/rl-dataset-gates"),
    Path("runtime-artifacts/rl-control-loop"),
    Path("runtime-artifacts/rl-training"),
)
RUNTIME_SUMMARY_PREFIX = "#runtime-summary "
DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024
EXPANSION_SPAWN_GRACE_TICKS = 1500


SCHEMA_SQL = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS metric_definitions (
  metric_name TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  purpose TEXT NOT NULL,
  source_artifacts TEXT NOT NULL,
  directionality TEXT NOT NULL,
  interpretation TEXT NOT NULL,
  missing_coverage_behavior TEXT NOT NULL,
  promotion_rule TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS metric_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_name TEXT NOT NULL,
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  tick INTEGER,
  shard TEXT,
  room_name TEXT,
  value REAL,
  value_text TEXT,
  unit TEXT,
  source_artifact TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_room_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  tick INTEGER,
  shard TEXT,
  room_name TEXT NOT NULL,
  pending_build_progress REAL,
  build_carried_energy REAL,
  build_blocked_reason TEXT,
  construction_site_count REAL,
  extension_count REAL,
  extension_capacity_contribution REAL,
  path_finding_failures REAL,
  destination_blocked REAL,
  worker_load_trip_energy_mean REAL,
  worker_load_trip_energy_min REAL,
  cpu_used REAL,
  cpu_bucket REAL,
  rcl_level REAL,
  stored_energy REAL,
  source_artifact TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gameplay_behavior_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_key TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  room_name TEXT,
  tick INTEGER,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  source_artifact TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  recommendation TEXT NOT NULL,
  promotion_state TEXT NOT NULL DEFAULT 'candidate',
  dedupe_key TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metric_coverage_gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_name TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  source_artifact TEXT NOT NULL,
  room_name TEXT,
  tick INTEGER,
  gap_type TEXT NOT NULL,
  message TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  dedupe_key TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rl_dataset_gate_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gate_id TEXT,
  status TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  value REAL,
  source_artifact TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  dedupe_key TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rl_training_execution_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT,
  variant_id TEXT,
  metric_name TEXT NOT NULL,
  value REAL,
  source_artifact TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  dedupe_key TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rl_policy_advantage_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT,
  candidate_id TEXT,
  incumbent_id TEXT,
  metric_name TEXT NOT NULL,
  value REAL,
  directionality TEXT NOT NULL,
  source_artifact TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  dedupe_key TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metric_iteration_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_key TEXT NOT NULL,
  status TEXT NOT NULL,
  source_artifact TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(decision_key, source_artifact)
);

CREATE INDEX IF NOT EXISTS idx_metric_observations_metric_tick
  ON metric_observations(metric_name, tick);
CREATE INDEX IF NOT EXISTS idx_runtime_room_metrics_room_tick
  ON runtime_room_metrics(room_name, tick);
CREATE INDEX IF NOT EXISTS idx_findings_category_severity
  ON gameplay_behavior_findings(category, severity);
CREATE INDEX IF NOT EXISTS idx_coverage_metric
  ON metric_coverage_gaps(metric_name, severity);
"""


METRIC_DEFINITIONS = [
    {
        "metric_name": "source.runtime_summary_console.present",
        "category": "metric coverage",
        "purpose": "Detect whether saved #runtime-summary artifacts are available to the PDCA Check loop.",
        "source_artifacts": "runtime-artifacts/runtime-summary-console",
        "directionality": "higher is better",
        "interpretation": "1 means the root exists and was scanned; a gap means runtime summary evidence is absent.",
        "missing_coverage_behavior": "Insert a coverage gap for the source root and do not fail ingestion.",
        "promotion_rule": "If absent for two steward windows, create/refresh a construction issue for runtime capture.",
    },
    {
        "metric_name": "source.rl_dataset_gates.present",
        "category": "metric coverage",
        "purpose": "Detect whether RL dataset/evaluation gate artifacts are available.",
        "source_artifacts": "runtime-artifacts/rl-dataset-gates",
        "directionality": "higher is better",
        "interpretation": "1 means gate artifacts were scanned.",
        "missing_coverage_behavior": "Insert a coverage gap and continue.",
        "promotion_rule": "Repeated absence blocks RL rollout evidence and should promote to an RL pipeline issue.",
    },
    {
        "metric_name": "source.rl_control_loop.present",
        "category": "metric coverage",
        "purpose": "Detect whether RL control-loop decision artifacts are available.",
        "source_artifacts": "runtime-artifacts/rl-control-loop",
        "directionality": "higher is better",
        "interpretation": "1 means control-loop artifacts were scanned.",
        "missing_coverage_behavior": "Insert a coverage gap and continue.",
        "promotion_rule": "Repeated absence promotes to a control-loop observability issue.",
    },
    {
        "metric_name": "source.rl_training.present",
        "category": "metric coverage",
        "purpose": "Detect whether RL training report artifacts are available.",
        "source_artifacts": "runtime-artifacts/rl-training",
        "directionality": "higher is better",
        "interpretation": "1 means training artifacts were scanned.",
        "missing_coverage_behavior": "Insert a coverage gap and continue.",
        "promotion_rule": "Repeated absence during active training work promotes to an RL experiment evidence issue.",
    },
    {
        "metric_name": "survival.owned_rooms",
        "category": "survival/ownership",
        "purpose": "Count claimed rooms visible in runtime summary evidence.",
        "source_artifacts": "#runtime-summary JSON/log lines",
        "directionality": "higher is better",
        "interpretation": "Drops indicate territory loss or missing visibility.",
        "missing_coverage_behavior": "Record a coverage gap when room ownership fields are absent.",
        "promotion_rule": "Severe drops create P0 recovery work; missing data creates telemetry work.",
    },
    {
        "metric_name": "survival.owned_spawns",
        "category": "survival/ownership",
        "purpose": "Count owned spawns per room.",
        "source_artifacts": "#runtime-summary room spawnStatus/structures fields",
        "directionality": "higher is better",
        "interpretation": "0 in a claimed room after grace is expansion collapse or unrecovered spawn loss.",
        "missing_coverage_behavior": "Record missing spawn telemetry coverage.",
        "promotion_rule": "Critical when claimed room has 0 spawns after grace or during survival recovery.",
    },
    {
        "metric_name": "survival.claimed_room_without_spawn_age_ticks",
        "category": "survival/ownership",
        "purpose": "Track claimed rooms without spawn infrastructure against the expansion grace window.",
        "source_artifacts": "#runtime-summary controller/claim-age/spawn fields",
        "directionality": "lower is better",
        "interpretation": "A value above grace means expansion survival is failing.",
        "missing_coverage_behavior": "Record a gap if claim age is not emitted.",
        "promotion_rule": "Critical after grace; warning while age telemetry is missing.",
    },
    {
        "metric_name": "territory.rcl_level",
        "category": "survival/ownership",
        "purpose": "Track room controller level from room-level runtime summary fields.",
        "source_artifacts": "#runtime-summary room.rclLevel or controller.level",
        "directionality": "higher is better",
        "interpretation": "RCL progression is durable territory/economy capability evidence.",
        "missing_coverage_behavior": "Leave historical rows NULL and rely on controller coverage gaps.",
        "promotion_rule": "Repeated absence promotes controller-level telemetry work.",
    },
    {
        "metric_name": "economy.energy_available",
        "category": "resource economy",
        "purpose": "Track room spawn/extension energy availability.",
        "source_artifacts": "#runtime-summary energyAvailable or energy.available",
        "directionality": "contextual",
        "interpretation": "Low values are normal after spawn/build spend but dangerous during worker recovery.",
        "missing_coverage_behavior": "Record an energy telemetry coverage gap.",
        "promotion_rule": "Repeated absence promotes to runtime-summary energy telemetry work.",
    },
    {
        "metric_name": "economy.stored_energy",
        "category": "resource economy",
        "purpose": "Track durable room energy reserves.",
        "source_artifacts": "#runtime-summary resources.storedEnergy",
        "directionality": "higher is better",
        "interpretation": "Persistent 0/low values indicate starvation or missing storage visibility.",
        "missing_coverage_behavior": "Record an energy telemetry coverage gap.",
        "promotion_rule": "Repeated starvation promotes economy recovery work; missing data promotes telemetry work.",
    },
    {
        "metric_name": "economy.worker_carried_energy",
        "category": "resource economy",
        "purpose": "Track energy currently carried by workers.",
        "source_artifacts": "#runtime-summary resources.workerCarriedEnergy",
        "directionality": "contextual",
        "interpretation": "Carried energy with no sink work indicates role/task imbalance.",
        "missing_coverage_behavior": "Record an energy telemetry coverage gap.",
        "promotion_rule": "Repeated absence promotes worker energy telemetry work.",
    },
    {
        "metric_name": "economy.energy_telemetry",
        "category": "metric coverage",
        "purpose": "Boolean coverage marker for at least one usable room energy field.",
        "source_artifacts": "#runtime-summary energy/resource fields",
        "directionality": "higher is better",
        "interpretation": "0/gap means economy behavior cannot be judged safely.",
        "missing_coverage_behavior": "Insert metric_coverage_gaps instead of inferring economy state.",
        "promotion_rule": "Repeated gap promotes to telemetry construction issue.",
    },
    {
        "metric_name": "creep.worker_count",
        "category": "creep efficiency",
        "purpose": "Track visible owned worker/creep count per room.",
        "source_artifacts": "#runtime-summary workerCount/ownedCreeps fields",
        "directionality": "higher is better until target met",
        "interpretation": "0 or drops can explain energy/construction deadlocks.",
        "missing_coverage_behavior": "Record a worker telemetry coverage gap.",
        "promotion_rule": "Critical during recovery if no workers and spawn can act.",
    },
    {
        "metric_name": "creep.low_load_return_count",
        "category": "creep efficiency",
        "purpose": "Count low-load worker return events such as 2/50 energy returns outside emergencies.",
        "source_artifacts": "#runtime-summary behavior/worker-efficiency fields",
        "directionality": "lower is better",
        "interpretation": "Persistent values mean workers waste travel/CPU and starve sinks.",
        "missing_coverage_behavior": "Record a coverage gap when no low-load return fields are emitted.",
        "promotion_rule": "Repeated nonzero values promote to worker logistics issue.",
    },
    {
        "metric_name": "creep.return_load_factor",
        "category": "creep efficiency",
        "purpose": "Track carried/capacity ratio on worker returns.",
        "source_artifacts": "#runtime-summary low-load/load-factor fields",
        "directionality": "higher is better",
        "interpretation": "Very low values without emergency exception are irrational logistics behavior.",
        "missing_coverage_behavior": "Record low-load telemetry gap.",
        "promotion_rule": "Repeated sub-0.10 values promote to logistics issue.",
    },
    {
        "metric_name": "creep.worker_load_trip_energy_mean",
        "category": "creep efficiency",
        "purpose": "Track average worker trip energy from runtime load-efficiency telemetry.",
        "source_artifacts": "#runtime-summary workerLoadEfficiency.tripEnergyMean",
        "directionality": "higher is better",
        "interpretation": "Values below 10 energy/trip indicate severe logistics waste outside emergencies.",
        "missing_coverage_behavior": "Record low-load telemetry gap.",
        "promotion_rule": "Repeated low means promote to worker logistics issue.",
    },
    {
        "metric_name": "creep.worker_load_trip_energy_min",
        "category": "creep efficiency",
        "purpose": "Track minimum worker trip energy from runtime load-efficiency telemetry.",
        "source_artifacts": "#runtime-summary workerLoadEfficiency.tripEnergyMin",
        "directionality": "higher is better",
        "interpretation": "A minimum below 10 identifies specific low-yield trips.",
        "missing_coverage_behavior": "Record low-load telemetry gap.",
        "promotion_rule": "Repeated low means promote to worker logistics issue.",
    },
    {
        "metric_name": "creep.idle_count",
        "category": "creep efficiency",
        "purpose": "Track idle/actionless worker count or idle tick windows.",
        "source_artifacts": "#runtime-summary behavior fields",
        "directionality": "lower is better",
        "interpretation": "High idle/actionless windows indicate missing targets, pathing blocks, or saturated sinks.",
        "missing_coverage_behavior": "Record stuck/actionless telemetry gap.",
        "promotion_rule": "Critical if long windows repeat in same room.",
    },
    {
        "metric_name": "creep.stuck_ticks",
        "category": "creep efficiency",
        "purpose": "Track stuck or actionless creep windows.",
        "source_artifacts": "#runtime-summary stuck/actionless fields",
        "directionality": "lower is better",
        "interpretation": "Long windows waste CPU and block planned work.",
        "missing_coverage_behavior": "Record stuck/actionless telemetry gap.",
        "promotion_rule": "Critical if >=50 ticks repeats or blocks survival work.",
    },
    {
        "metric_name": "creep.path_finding_failures",
        "category": "creep efficiency",
        "purpose": "Count inferred pathing failure ticks from stuck workers with no work ticks.",
        "source_artifacts": "#runtime-summary behavior.totals.pathFindingFailures",
        "directionality": "lower is better",
        "interpretation": "Nonzero values indicate pathing or blocked target failures are wasting creep ticks.",
        "missing_coverage_behavior": "Record stuck/actionless telemetry gap.",
        "promotion_rule": "Repeated nonzero values promote pathing recovery work.",
    },
    {
        "metric_name": "creep.destination_blocked",
        "category": "creep efficiency",
        "purpose": "Count blocked destinations inferred from stuck no-work creep samples.",
        "source_artifacts": "#runtime-summary behavior.totals.destinationBlocked",
        "directionality": "lower is better",
        "interpretation": "Nonzero values distinguish target obstruction from ordinary idle windows.",
        "missing_coverage_behavior": "Record stuck/actionless telemetry gap.",
        "promotion_rule": "Repeated nonzero values promote target/path selection work.",
    },
    {
        "metric_name": "construction.backlog_progress",
        "category": "construction/infrastructure",
        "purpose": "Track remaining construction/progress backlog.",
        "source_artifacts": "#runtime-summary resources.productiveEnergy and constructionPriority",
        "directionality": "lower is better when planned work should progress",
        "interpretation": "Backlog with no build progress means construction is stalled.",
        "missing_coverage_behavior": "Record construction telemetry gap when priority exists but backlog/progress is absent.",
        "promotion_rule": "Repeated backlog with zero build promotes to construction issue.",
    },
    {
        "metric_name": "construction.pending_build_progress",
        "category": "construction/infrastructure",
        "purpose": "Track remaining progress across owned construction sites.",
        "source_artifacts": "#runtime-summary pendingBuildProgress",
        "directionality": "lower is better when planned work should progress",
        "interpretation": "Positive values mean build work remains available in the room.",
        "missing_coverage_behavior": "Leave historical rows NULL and fall back to backlog coverage gaps.",
        "promotion_rule": "Repeated positive value with no build work promotes construction issue.",
    },
    {
        "metric_name": "construction.site_count",
        "category": "construction/infrastructure",
        "purpose": "Track active owned construction site count per room.",
        "source_artifacts": "#runtime-summary constructionSiteCount",
        "directionality": "lower is better after planned sites complete",
        "interpretation": "Nonzero sites identify build backlog shape and help distinguish no-work from no-builder states.",
        "missing_coverage_behavior": "Leave historical rows NULL and use construction backlog gaps.",
        "promotion_rule": "Repeated nonzero value with no build progress promotes construction issue.",
    },
    {
        "metric_name": "construction.build_task_count",
        "category": "construction/infrastructure",
        "purpose": "Track workers assigned to build tasks.",
        "source_artifacts": "#runtime-summary taskCounts.build",
        "directionality": "contextual",
        "interpretation": "0 while backlog exists is a stalled construction signal.",
        "missing_coverage_behavior": "Record task assignment coverage gap.",
        "promotion_rule": "Repeated 0 with backlog promotes to construction issue.",
    },
    {
        "metric_name": "construction.built_progress",
        "category": "construction/infrastructure",
        "purpose": "Track actual build progress emitted by the bot/runtime summary.",
        "source_artifacts": "#runtime-summary build/progress fields",
        "directionality": "higher is better when backlog exists",
        "interpretation": "0 while backlog remains indicates builders are not completing work.",
        "missing_coverage_behavior": "Record progress telemetry gap when backlog exists.",
        "promotion_rule": "Repeated 0/gap with backlog promotes to construction telemetry or behavior issue.",
    },
    {
        "metric_name": "construction.build_carried_energy",
        "category": "construction/infrastructure",
        "purpose": "Track energy carried/used by builders.",
        "source_artifacts": "#runtime-summary buildCarriedEnergy fields",
        "directionality": "higher is better when backlog exists",
        "interpretation": "0 with backlog confirms builders are not servicing construction.",
        "missing_coverage_behavior": "Record progress telemetry gap when backlog exists.",
        "promotion_rule": "Repeated 0/gap with backlog promotes to construction issue.",
    },
    {
        "metric_name": "construction.build_blocked_reason",
        "category": "construction/infrastructure",
        "purpose": "Classify why visible construction backlog is not producing build work.",
        "source_artifacts": "#runtime-summary resources.productiveEnergy.buildBlockedReason",
        "directionality": "categorical",
        "interpretation": "worker_assignment_gap means energy/backlog exists but no builder assignment is visible; energy_buffer_blocked means construction should wait for recovery energy.",
        "missing_coverage_behavior": "Record construction blocked-reason coverage gap when backlog exists.",
        "promotion_rule": "Repeated worker_assignment_gap with backlog promotes construction assignment work.",
    },
    {
        "metric_name": "economy.extension_count",
        "category": "resource economy",
        "purpose": "Track completed extension infrastructure per room.",
        "source_artifacts": "#runtime-summary structures.extensionCount",
        "directionality": "higher is better until RCL cap",
        "interpretation": "A flat zero at RCL2+ explains spawn-only energy capacity.",
        "missing_coverage_behavior": "Record extension telemetry gap when structure snapshots are missing.",
        "promotion_rule": "Repeated zero/absence with RCL2+ promotes extension construction telemetry/work.",
    },
    {
        "metric_name": "economy.extension_capacity_contribution",
        "category": "resource economy",
        "purpose": "Track extension energy capacity contribution separate from spawn capacity.",
        "source_artifacts": "#runtime-summary structures.extensionCapacityContribution",
        "directionality": "higher is better until RCL cap",
        "interpretation": "0 means room capacity is likely spawn-only.",
        "missing_coverage_behavior": "Record extension capacity coverage gap.",
        "promotion_rule": "Repeated zero capacity at RCL2+ promotes extension construction work.",
    },
    {
        "metric_name": "construction.defense_backlog",
        "category": "defense readiness",
        "purpose": "Track tower/rampart/defense construction backlog.",
        "source_artifacts": "#runtime-summary constructionPriority and defense fields",
        "directionality": "lower is better when threatened",
        "interpretation": "Defense backlog during threat with no builders is a P0 survival risk.",
        "missing_coverage_behavior": "Record defense construction coverage gap.",
        "promotion_rule": "Critical when hostile/threat evidence is present.",
    },
    {
        "metric_name": "defense.hostile_creep_count",
        "category": "defense readiness",
        "purpose": "Track visible hostile creeps.",
        "source_artifacts": "#runtime-summary combat.hostileCreepCount",
        "directionality": "lower is better",
        "interpretation": "Nonzero hostiles require defense readiness and construction response.",
        "missing_coverage_behavior": "Record combat telemetry gap.",
        "promotion_rule": "Missing combat data during defense incidents promotes telemetry issue.",
    },
    {
        "metric_name": "defense.tower_count",
        "category": "defense readiness",
        "purpose": "Track tower infrastructure count.",
        "source_artifacts": "#runtime-summary structures.tower/towers",
        "directionality": "higher is better until target met",
        "interpretation": "0 during threat/backlog is missing defense infrastructure.",
        "missing_coverage_behavior": "Record defense infra telemetry gap.",
        "promotion_rule": "Critical with hostiles or high-urgency defense backlog.",
    },
    {
        "metric_name": "defense.rampart_count",
        "category": "defense readiness",
        "purpose": "Track rampart infrastructure count.",
        "source_artifacts": "#runtime-summary structures.rampart/ramparts",
        "directionality": "higher is better until defensive plan met",
        "interpretation": "0 during tower/rampart backlog means defense construction is late.",
        "missing_coverage_behavior": "Record defense infra telemetry gap.",
        "promotion_rule": "Critical with hostiles or high-urgency defense backlog.",
    },
    {
        "metric_name": "behavior.upgrade_dominance_ratio",
        "category": "gameplay behavior",
        "purpose": "Track fraction of workers assigned to upgrade while capacity/defense/construction backlog exists.",
        "source_artifacts": "#runtime-summary taskCounts",
        "directionality": "lower is better when backlog exists",
        "interpretation": "High upgrade dominance with urgent backlog is misprioritized progress.",
        "missing_coverage_behavior": "Record task/backlog coverage gap.",
        "promotion_rule": "Repeated high ratio with urgent backlog promotes to prioritization issue.",
    },
    {
        "metric_name": "cpu.bucket",
        "category": "CPU/reliability",
        "purpose": "Track Screeps CPU bucket resilience.",
        "source_artifacts": "#runtime-summary cpu.bucket",
        "directionality": "higher is better",
        "interpretation": "Low bucket constrains runtime behavior and can mask policy quality.",
        "missing_coverage_behavior": "Record CPU telemetry gap.",
        "promotion_rule": "Repeated low/missing CPU data promotes reliability instrumentation work.",
    },
    {
        "metric_name": "cpu.used",
        "category": "CPU/reliability",
        "purpose": "Track CPU used per tick/window when available.",
        "source_artifacts": "#runtime-summary cpu.used",
        "directionality": "lower is better for equal outcome",
        "interpretation": "Spikes may correlate with stuck/pathing behavior.",
        "missing_coverage_behavior": "Record CPU telemetry gap.",
        "promotion_rule": "Repeated missing data promotes runtime CPU instrumentation work.",
    },
    {
        "metric_name": "reliability.loop_exception_count",
        "category": "CPU/reliability",
        "purpose": "Track tick-loop exception count.",
        "source_artifacts": "#runtime-summary reliability.loopExceptionCount",
        "directionality": "lower is better",
        "interpretation": "Any nonzero value can invalidate behavior evidence.",
        "missing_coverage_behavior": "Record reliability telemetry gap.",
        "promotion_rule": "Nonzero values promote to P0 runtime correctness issue.",
    },
    {
        "metric_name": "reliability.telemetry_silence_ticks",
        "category": "CPU/reliability",
        "purpose": "Track telemetry silence windows.",
        "source_artifacts": "#runtime-summary reliability.telemetrySilenceTicks",
        "directionality": "lower is better",
        "interpretation": "Silence means the Check loop may be blind.",
        "missing_coverage_behavior": "Record reliability telemetry gap.",
        "promotion_rule": "Repeated silence promotes runtime monitor/capture issue.",
    },
    {
        "metric_name": "rl.dataset_gate.status",
        "category": "RL dataset/training/policy",
        "purpose": "Persist pass/fail/not-configured dataset gate status.",
        "source_artifacts": "runtime-artifacts/rl-dataset-gates",
        "directionality": "pass is better",
        "interpretation": "Failing gates block policy advancement and become behavior findings.",
        "missing_coverage_behavior": "Record source-root coverage gap.",
        "promotion_rule": "Repeated failures promote to RL dataset quality issue.",
    },
    {
        "metric_name": "rl.training.execution_sample_count",
        "category": "RL dataset/training/policy",
        "purpose": "Track training simulator sample count by variant.",
        "source_artifacts": "runtime-artifacts/rl-training",
        "directionality": "higher is better until experiment target met",
        "interpretation": "0 samples make training comparisons unusable.",
        "missing_coverage_behavior": "Record RL training coverage gap.",
        "promotion_rule": "Repeated 0/missing values promote to simulator/training issue.",
    },
    {
        "metric_name": "rl.policy.advantage_territory",
        "category": "RL dataset/training/policy",
        "purpose": "Track candidate policy territory reward advantage.",
        "source_artifacts": "runtime-artifacts/rl-training reports",
        "directionality": "higher is better",
        "interpretation": "Positive territory advantage is the first lexicographic objective.",
        "missing_coverage_behavior": "Record RL policy comparison gap.",
        "promotion_rule": "Repeated negative territory advantage blocks rollout and feeds experiment iteration.",
    },
    {
        "metric_name": "rl.policy.advantage_resources",
        "category": "RL dataset/training/policy",
        "purpose": "Track candidate policy resource reward advantage after territory tie.",
        "source_artifacts": "runtime-artifacts/rl-training reports",
        "directionality": "higher is better",
        "interpretation": "Positive value matters only after territory is not worse.",
        "missing_coverage_behavior": "Record RL policy comparison gap.",
        "promotion_rule": "Repeated negative value feeds reward/strategy iteration.",
    },
    {
        "metric_name": "rl.policy.advantage_kills",
        "category": "RL dataset/training/policy",
        "purpose": "Track candidate policy kill reward advantage after territory/resources.",
        "source_artifacts": "runtime-artifacts/rl-training reports",
        "directionality": "higher is better",
        "interpretation": "Positive value matters after territory and resources.",
        "missing_coverage_behavior": "Record RL policy comparison gap.",
        "promotion_rule": "Repeated negative value feeds combat-policy iteration.",
    },
]


SOURCE_ROOT_METRICS = {
    "runtime-summary-console": "source.runtime_summary_console.present",
    "rl-dataset-gates": "source.rl_dataset_gates.present",
    "rl-control-loop": "source.rl_control_loop.present",
    "rl-training": "source.rl_training.present",
}


RUNTIME_ROOM_METRIC_COLUMNS = {
    "pending_build_progress": "REAL",
    "build_carried_energy": "REAL",
    "build_blocked_reason": "TEXT",
    "construction_site_count": "REAL",
    "extension_count": "REAL",
    "extension_capacity_contribution": "REAL",
    "path_finding_failures": "REAL",
    "destination_blocked": "REAL",
    "worker_load_trip_energy_mean": "REAL",
    "worker_load_trip_energy_min": "REAL",
    "cpu_used": "REAL",
    "cpu_bucket": "REAL",
    "rcl_level": "REAL",
    "stored_energy": "REAL",
}


DEDUPE_TABLE_KEYS = {
    "metric_observations": ("metric_name", "tick", "room_name", "source_artifact", "evidence_json"),
    "runtime_room_metrics": ("tick", "shard", "room_name", "source_artifact"),
    "gameplay_behavior_findings": ("finding_key", "source_artifact", "tick", "room_name"),
    "metric_coverage_gaps": ("metric_name", "source_artifact", "room_name", "tick", "gap_type"),
    "rl_dataset_gate_metrics": ("gate_id", "status", "metric_name", "source_artifact", "evidence_json"),
    "rl_training_execution_metrics": ("report_id", "variant_id", "metric_name", "source_artifact", "evidence_json"),
    "rl_policy_advantage_metrics": (
        "report_id",
        "candidate_id",
        "incumbent_id",
        "metric_name",
        "source_artifact",
        "evidence_json",
    ),
}


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def canonical_json_field(value: object) -> object:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def dedupe_key_for_fields(table_name: str, fields: dict[str, object]) -> str:
    normalized_fields = {
        key: canonical_json_field(value) if key == "evidence_json" else value for key, value in fields.items()
    }
    payload = {"table": table_name, "fields": normalized_fields}
    digest = hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def dedupe_key_for_values(table_name: str, **fields: object) -> str:
    return dedupe_key_for_fields(table_name, fields)


def display_path(path: Path | str) -> str:
    text = str(path)
    lowered = text.lower()
    if any(marker in lowered for marker in ("token", "secret", "password", "steam_key")):
        return "[redacted-path]"
    try:
        path_obj = Path(path).expanduser()
        resolved = path_obj.resolve()
        return str(resolved.relative_to(Path.cwd().resolve()))
    except (OSError, ValueError):
        return text


def as_dict(value: object) -> dict[str, object]:
    return value if isinstance(value, dict) else {}


def as_list(value: object) -> list[object]:
    return value if isinstance(value, list) else []


def number_value(value: object) -> float | None:
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
    if parsed != parsed or parsed in (float("inf"), float("-inf")):
        return None
    return parsed


def integer_value(value: object) -> int | None:
    numeric = number_value(value)
    if numeric is None:
        return None
    return int(numeric)


def text_value(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def nested_value(value: object, path: tuple[str, ...]) -> object:
    current = value
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def first_number(value: object, paths: tuple[tuple[str, ...], ...]) -> float | None:
    for path in paths:
        found = number_value(nested_value(value, path))
        if found is not None:
            return found
    return None


def normalized_key(value: str) -> str:
    return "".join(character for character in value.lower() if character.isalnum())


def find_first_number_by_keys(value: object, key_names: tuple[str, ...]) -> float | None:
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


def find_first_text_by_keys(value: object, key_names: tuple[str, ...]) -> str | None:
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


def collect_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return " ".join(collect_text(item) for item in value.values())
    if isinstance(value, list):
        return " ".join(collect_text(item) for item in value)
    return ""


def contains_any(value: str, needles: tuple[str, ...]) -> bool:
    lowered = value.lower()
    return any(needle in lowered for needle in needles)


def connect_database(db_path: Path) -> sqlite3.Connection:
    db_path.expanduser().parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path.expanduser()))
    conn.row_factory = sqlite3.Row
    return conn


def table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()}


def ensure_runtime_room_metrics_schema(conn: sqlite3.Connection) -> None:
    columns = table_columns(conn, "runtime_room_metrics")
    for column_name, column_type in RUNTIME_ROOM_METRIC_COLUMNS.items():
        if column_name not in columns:
            conn.execute(f"ALTER TABLE runtime_room_metrics ADD COLUMN {column_name} {column_type}")


def ensure_dedupe_schema(conn: sqlite3.Connection) -> None:
    for table_name, key_columns in DEDUPE_TABLE_KEYS.items():
        columns = table_columns(conn, table_name)
        if not columns:
            continue
        if "dedupe_key" not in columns:
            conn.execute(f"ALTER TABLE {table_name} ADD COLUMN dedupe_key TEXT")
        backfill_dedupe_keys(conn, table_name, key_columns)
        remove_duplicate_dedupe_rows(conn, table_name)
        conn.execute(
            f"CREATE UNIQUE INDEX IF NOT EXISTS idx_{table_name}_dedupe_key "
            f"ON {table_name}(dedupe_key)"
        )


def backfill_dedupe_keys(conn: sqlite3.Connection, table_name: str, key_columns: tuple[str, ...]) -> None:
    selected_columns = ", ".join(("id", *key_columns))
    rows = conn.execute(
        f"""
        SELECT {selected_columns}
        FROM {table_name}
        WHERE dedupe_key IS NULL OR dedupe_key = ''
        """
    ).fetchall()
    for row in rows:
        fields = {column: row[column] for column in key_columns}
        conn.execute(
            f"UPDATE {table_name} SET dedupe_key = ? WHERE id = ?",
            (dedupe_key_for_fields(table_name, fields), row["id"]),
        )


def remove_duplicate_dedupe_rows(conn: sqlite3.Connection, table_name: str) -> None:
    conn.execute(
        f"""
        DELETE FROM {table_name}
        WHERE dedupe_key IS NOT NULL
          AND id NOT IN (
            SELECT MIN(id)
            FROM {table_name}
            GROUP BY dedupe_key
          )
        """
    )


def initialize_database(db_path: Path) -> dict[str, int]:
    with connect_database(db_path) as conn:
        conn.executescript(SCHEMA_SQL)
        ensure_runtime_room_metrics_schema(conn)
        ensure_dedupe_schema(conn)
        upsert_metric_definitions(conn)
        conn.commit()
        definition_count = conn.execute("SELECT COUNT(*) FROM metric_definitions").fetchone()[0]
    return {"metric_definitions": int(definition_count)}


def upsert_metric_definitions(conn: sqlite3.Connection) -> None:
    for definition in METRIC_DEFINITIONS:
        conn.execute(
            """
            INSERT INTO metric_definitions (
              metric_name, category, purpose, source_artifacts, directionality,
              interpretation, missing_coverage_behavior, promotion_rule
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(metric_name) DO UPDATE SET
              category=excluded.category,
              purpose=excluded.purpose,
              source_artifacts=excluded.source_artifacts,
              directionality=excluded.directionality,
              interpretation=excluded.interpretation,
              missing_coverage_behavior=excluded.missing_coverage_behavior,
              promotion_rule=excluded.promotion_rule,
              updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            """,
            (
                definition["metric_name"],
                definition["category"],
                definition["purpose"],
                definition["source_artifacts"],
                definition["directionality"],
                definition["interpretation"],
                definition["missing_coverage_behavior"],
                definition["promotion_rule"],
            ),
        )


def record_observation(
    conn: sqlite3.Connection,
    metric_name: str,
    value: float | None,
    *,
    source_artifact: str,
    tick: int | None = None,
    shard: str | None = None,
    room_name: str | None = None,
    unit: str | None = None,
    evidence: object | None = None,
    value_text: str | None = None,
) -> None:
    evidence_json = canonical_json(evidence or {})
    dedupe_key = dedupe_key_for_values(
        "metric_observations",
        metric_name=metric_name,
        tick=tick,
        room_name=room_name,
        source_artifact=source_artifact,
        evidence_json=evidence_json,
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO metric_observations (
          metric_name, tick, shard, room_name, value, value_text, unit, source_artifact,
          evidence_json, dedupe_key
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            metric_name,
            tick,
            shard,
            room_name,
            value,
            value_text,
            unit,
            source_artifact,
            evidence_json,
            dedupe_key,
        ),
    )


def record_runtime_room_metrics(
    conn: sqlite3.Connection,
    *,
    source_artifact: str,
    tick: int | None,
    shard: str | None,
    room_name: str,
    pending_build_progress: float | None,
    build_carried_energy: float | None,
    build_blocked_reason: str | None,
    construction_site_count: float | None,
    extension_count: float | None,
    extension_capacity_contribution: float | None,
    path_finding_failures: float | None,
    destination_blocked: float | None,
    worker_load_trip_energy_mean: float | None,
    worker_load_trip_energy_min: float | None,
    cpu_used: float | None,
    cpu_bucket: float | None,
    rcl_level: float | None,
    stored_energy: float | None,
    evidence: object | None = None,
) -> None:
    evidence_json = canonical_json(evidence or {})
    dedupe_key = dedupe_key_for_values(
        "runtime_room_metrics",
        tick=tick,
        shard=shard,
        room_name=room_name,
        source_artifact=source_artifact,
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO runtime_room_metrics (
          tick, shard, room_name, pending_build_progress, build_carried_energy,
          build_blocked_reason, construction_site_count, extension_count,
          extension_capacity_contribution, path_finding_failures, destination_blocked,
          worker_load_trip_energy_mean, worker_load_trip_energy_min,
          cpu_used, cpu_bucket, rcl_level, stored_energy,
          source_artifact, evidence_json, dedupe_key
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            tick,
            shard,
            room_name,
            pending_build_progress,
            build_carried_energy,
            build_blocked_reason,
            construction_site_count,
            extension_count,
            extension_capacity_contribution,
            path_finding_failures,
            destination_blocked,
            worker_load_trip_energy_mean,
            worker_load_trip_energy_min,
            cpu_used,
            cpu_bucket,
            rcl_level,
            stored_energy,
            source_artifact,
            evidence_json,
            dedupe_key,
        ),
    )


def record_finding(
    conn: sqlite3.Connection,
    *,
    finding_key: str,
    category: str,
    severity: str,
    metric_name: str,
    source_artifact: str,
    recommendation: str,
    tick: int | None = None,
    room_name: str | None = None,
    evidence: object | None = None,
    promotion_state: str = "candidate",
) -> None:
    evidence_json = canonical_json(evidence or {})
    dedupe_key = dedupe_key_for_values(
        "gameplay_behavior_findings",
        finding_key=finding_key,
        source_artifact=source_artifact,
        tick=tick,
        room_name=room_name,
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO gameplay_behavior_findings (
          finding_key, category, severity, room_name, tick, source_artifact,
          metric_name, evidence_json, recommendation, promotion_state, dedupe_key
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            finding_key,
            category,
            severity,
            room_name,
            tick,
            source_artifact,
            metric_name,
            evidence_json,
            recommendation,
            promotion_state,
            dedupe_key,
        ),
    )


def record_coverage_gap(
    conn: sqlite3.Connection,
    *,
    metric_name: str,
    category: str,
    severity: str,
    source_artifact: str,
    gap_type: str,
    message: str,
    tick: int | None = None,
    room_name: str | None = None,
    evidence: object | None = None,
) -> None:
    evidence_json = canonical_json(evidence or {})
    dedupe_key = dedupe_key_for_values(
        "metric_coverage_gaps",
        metric_name=metric_name,
        source_artifact=source_artifact,
        room_name=room_name,
        tick=tick,
        gap_type=gap_type,
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO metric_coverage_gaps (
          metric_name, category, severity, source_artifact, room_name, tick,
          gap_type, message, evidence_json, dedupe_key
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            metric_name,
            category,
            severity,
            source_artifact,
            room_name,
            tick,
            gap_type,
            message,
            evidence_json,
            dedupe_key,
        ),
    )


def record_dataset_gate_metric(
    conn: sqlite3.Connection,
    *,
    gate_id: str | None,
    status: str,
    metric_name: str,
    value: float | None,
    source_artifact: str,
    evidence: object | None = None,
) -> None:
    evidence_json = canonical_json(evidence or {})
    dedupe_key = dedupe_key_for_values(
        "rl_dataset_gate_metrics",
        gate_id=gate_id,
        status=status,
        metric_name=metric_name,
        source_artifact=source_artifact,
        evidence_json=evidence_json,
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO rl_dataset_gate_metrics (
          gate_id, status, metric_name, value, source_artifact, evidence_json, dedupe_key
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (gate_id, status, metric_name, value, source_artifact, evidence_json, dedupe_key),
    )


def record_training_metric(
    conn: sqlite3.Connection,
    *,
    report_id: str | None,
    variant_id: str | None,
    metric_name: str,
    value: float | None,
    source_artifact: str,
    evidence: object | None = None,
) -> None:
    evidence_json = canonical_json(evidence or {})
    dedupe_key = dedupe_key_for_values(
        "rl_training_execution_metrics",
        report_id=report_id,
        variant_id=variant_id,
        metric_name=metric_name,
        source_artifact=source_artifact,
        evidence_json=evidence_json,
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO rl_training_execution_metrics (
          report_id, variant_id, metric_name, value, source_artifact, evidence_json, dedupe_key
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (report_id, variant_id, metric_name, value, source_artifact, evidence_json, dedupe_key),
    )


def record_policy_advantage(
    conn: sqlite3.Connection,
    *,
    report_id: str | None,
    candidate_id: str | None,
    incumbent_id: str | None,
    metric_name: str,
    value: float | None,
    directionality: str,
    source_artifact: str,
    evidence: object | None = None,
) -> None:
    evidence_json = canonical_json(evidence or {})
    dedupe_key = dedupe_key_for_values(
        "rl_policy_advantage_metrics",
        report_id=report_id,
        candidate_id=candidate_id,
        incumbent_id=incumbent_id,
        metric_name=metric_name,
        source_artifact=source_artifact,
        evidence_json=evidence_json,
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO rl_policy_advantage_metrics (
          report_id, candidate_id, incumbent_id, metric_name, value,
          directionality, source_artifact, evidence_json, dedupe_key
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            report_id,
            candidate_id,
            incumbent_id,
            metric_name,
            value,
            directionality,
            source_artifact,
            evidence_json,
            dedupe_key,
        ),
    )


def record_iteration_decision(
    conn: sqlite3.Connection,
    *,
    decision_key: str,
    status: str,
    source_artifact: str,
    rationale: str,
    evidence: object | None = None,
) -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO metric_iteration_decisions (
          decision_key, status, source_artifact, rationale, evidence_json
        )
        VALUES (?, ?, ?, ?, ?)
        """,
        (decision_key, status, source_artifact, rationale, canonical_json(evidence or {})),
    )


def ingest_artifacts(db_path: Path, paths: list[Path], max_file_bytes: int = DEFAULT_MAX_FILE_BYTES) -> dict[str, int]:
    initialize_database(db_path)
    stats = {
        "source_roots": 0,
        "files_scanned": 0,
        "files_skipped": 0,
        "runtime_summaries": 0,
        "dataset_gate_artifacts": 0,
        "training_artifacts": 0,
        "iteration_decisions": 0,
        "coverage_gaps": 0,
    }
    artifact_paths = paths or list(DEFAULT_ARTIFACT_ROOTS)

    with connect_database(db_path) as conn:
        for raw_path in artifact_paths:
            path = raw_path.expanduser()
            source_metric = source_root_metric(path)
            if not path.exists():
                record_coverage_gap(
                    conn,
                    metric_name=source_metric,
                    category="metric coverage",
                    severity="warning",
                    source_artifact=display_path(path),
                    gap_type="missing_source_root",
                    message=f"artifact source root {display_path(path)} does not exist",
                )
                stats["coverage_gaps"] += 1
                continue
            stats["source_roots"] += 1
            record_observation(
                conn,
                source_metric,
                1,
                source_artifact=display_path(path),
                evidence={"sourceRoot": display_path(path)},
            )
            for file_path in iter_artifact_files(path):
                try:
                    file_size = file_path.stat().st_size
                except OSError:
                    file_size = DEFAULT_MAX_FILE_BYTES + 1
                if file_size > max_file_bytes:
                    record_coverage_gap(
                        conn,
                        metric_name="source.artifact_file_readable",
                        category="metric coverage",
                        severity="warning",
                        source_artifact=display_path(file_path),
                        gap_type="file_too_large",
                        message="artifact file exceeds max_file_bytes and was not scanned",
                        evidence={"maxFileBytes": max_file_bytes, "sizeBytes": file_size},
                    )
                    stats["files_skipped"] += 1
                    stats["coverage_gaps"] += 1
                    continue
                process_artifact_file(conn, file_path, stats)
        conn.commit()
    return stats


def source_root_metric(path: Path) -> str:
    for part in reversed(path.parts):
        metric = SOURCE_ROOT_METRICS.get(part)
        if metric is not None:
            return metric
    return "source.runtime_summary_console.present"


def iter_artifact_files(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    if not path.is_dir():
        return []
    try:
        return sorted(item for item in path.rglob("*") if item.is_file())
    except OSError:
        return []


def process_artifact_file(conn: sqlite3.Connection, path: Path, stats: dict[str, int]) -> None:
    source_artifact = display_path(path)
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        record_coverage_gap(
            conn,
            metric_name="source.artifact_file_readable",
            category="metric coverage",
            severity="warning",
            source_artifact=source_artifact,
            gap_type="read_error",
            message="artifact file could not be read as UTF-8 text",
        )
        stats["files_skipped"] += 1
        stats["coverage_gaps"] += 1
        return

    stats["files_scanned"] += 1
    runtime_line_count = process_runtime_summary_lines(conn, text, source_artifact, stats)
    if runtime_line_count:
        return

    parsed = parse_json_text(text)
    if parsed is not None:
        process_json_payload(conn, parsed, source_artifact, stats)
        return

    if path.suffix.lower() == ".ndjson":
        for line in text.splitlines():
            parsed_line = parse_json_text(line)
            if parsed_line is not None:
                process_json_payload(conn, parsed_line, source_artifact, stats)


def process_runtime_summary_lines(
    conn: sqlite3.Connection,
    text: str,
    source_artifact: str,
    stats: dict[str, int],
) -> int:
    count = 0
    for line_number, line in enumerate(text.splitlines(), start=1):
        if not line.startswith(RUNTIME_SUMMARY_PREFIX):
            continue
        parsed = parse_json_text(line[len(RUNTIME_SUMMARY_PREFIX) :])
        if isinstance(parsed, dict):
            process_runtime_summary(conn, parsed, source_artifact, stats, line_number=line_number)
            count += 1
    return count


def parse_json_text(text: str) -> object | None:
    stripped = text.strip()
    if not stripped:
        return None
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return None


def process_json_payload(
    conn: sqlite3.Connection,
    payload: object,
    source_artifact: str,
    stats: dict[str, int],
) -> None:
    if isinstance(payload, list):
        for item in payload:
            process_json_payload(conn, item, source_artifact, stats)
        return
    if not isinstance(payload, dict):
        return

    artifact_type = text_value(payload.get("type")) or text_value(payload.get("artifactType")) or ""
    if artifact_type == "runtime-summary":
        process_runtime_summary(conn, payload, source_artifact, stats, line_number=None)
    elif "dataset-evaluation-gate" in artifact_type or "datasetGate" in payload or "quality_checks" in payload:
        process_dataset_gate(conn, payload, source_artifact, stats)
    elif artifact_type == "screeps-rl-training-report" or "variantResults" in payload:
        process_training_report(conn, payload, source_artifact, stats)
    elif "decision" in payload or "feedbackIngestion" in payload or "blockingReasons" in payload:
        process_iteration_payload(conn, payload, source_artifact, stats)


def process_runtime_summary(
    conn: sqlite3.Connection,
    payload: dict[str, object],
    source_artifact: str,
    stats: dict[str, int],
    *,
    line_number: int | None,
) -> None:
    tick = integer_value(payload.get("tick") or payload.get("gameTime"))
    shard = text_value(payload.get("shard"))
    rooms = extract_rooms(payload)
    owned_rooms = sum(1 for room in rooms if room_is_claimed(room))
    record_observation(
        conn,
        "survival.owned_rooms",
        owned_rooms,
        source_artifact=source_artifact,
        tick=tick,
        shard=shard,
        evidence={"line": line_number, "roomCount": len(rooms)},
    )
    process_top_level_runtime_metrics(conn, payload, source_artifact, tick, shard)
    if not rooms:
        record_coverage_gap(
            conn,
            metric_name="survival.owned_rooms",
            category="survival/ownership",
            severity="warning",
            source_artifact=source_artifact,
            tick=tick,
            gap_type="missing_rooms",
            message="runtime summary did not contain a rooms list/object",
            evidence={"line": line_number},
        )
    for room in rooms:
        process_runtime_room(conn, payload, room, source_artifact, tick, shard, line_number)
    stats["runtime_summaries"] += 1


def extract_rooms(payload: dict[str, object]) -> list[dict[str, object]]:
    raw_rooms = payload.get("rooms")
    rooms: list[dict[str, object]] = []
    if isinstance(raw_rooms, list):
        for room in raw_rooms:
            if isinstance(room, dict):
                rooms.append(room)
    elif isinstance(raw_rooms, dict):
        for room_name, room in raw_rooms.items():
            if isinstance(room, dict):
                normalized = dict(room)
                normalized.setdefault("roomName", room_name)
                rooms.append(normalized)
    elif text_value(payload.get("roomName")):
        rooms.append(payload)
    return rooms


def process_top_level_runtime_metrics(
    conn: sqlite3.Connection,
    payload: dict[str, object],
    source_artifact: str,
    tick: int | None,
    shard: str | None,
) -> None:
    observed = {
        "cpu.bucket": first_number(payload, (("cpu", "bucket"), ("cpuBucket",))),
        "cpu.used": first_number(payload, (("cpu", "used"), ("cpuUsed",))),
        "reliability.loop_exception_count": first_number(
            payload,
            (("reliability", "loopExceptionCount"), ("loopExceptionCount",)),
        ),
        "reliability.telemetry_silence_ticks": first_number(
            payload,
            (("reliability", "telemetrySilenceTicks"), ("telemetrySilenceTicks",)),
        ),
    }
    for metric_name, value in observed.items():
        if value is None:
            record_coverage_gap(
                conn,
                metric_name=metric_name,
                category="CPU/reliability",
                severity="info",
                source_artifact=source_artifact,
                tick=tick,
                gap_type="missing_field",
                message=f"{metric_name} was not present in runtime summary",
            )
        else:
            record_observation(
                conn,
                metric_name,
                value,
                source_artifact=source_artifact,
                tick=tick,
                shard=shard,
            )
            if metric_name == "reliability.loop_exception_count" and value > 0:
                record_finding(
                    conn,
                    finding_key=f"loop-exceptions:{tick}",
                    category="runtime-reliability",
                    severity="critical",
                    metric_name=metric_name,
                    source_artifact=source_artifact,
                    tick=tick,
                    evidence={"loopExceptionCount": value},
                    recommendation="Fix tick-loop exceptions before trusting gameplay behavior metrics.",
                    promotion_state="promote-immediately",
                )


def process_runtime_room(
    conn: sqlite3.Connection,
    payload: dict[str, object],
    room: dict[str, object],
    source_artifact: str,
    tick: int | None,
    shard: str | None,
    line_number: int | None,
) -> None:
    del payload
    room_name = text_value(room.get("roomName")) or text_value(room.get("name")) or "unknown"
    spawn_count = room_spawn_count(room)
    worker_count = room_worker_count(room)
    task_counts = room_task_counts(room)
    build_tasks = task_count(task_counts, "build")
    upgrade_tasks = task_count(task_counts, "upgrade")
    construction_backlog = construction_backlog_progress(room)
    pending_build_progress = pending_build_progress_value(room)
    construction_site_count = construction_site_count_value(room)
    build_blocked_reason = build_blocked_reason_value(room)
    extension_count = extension_count_value(room)
    extension_capacity_contribution = extension_capacity_contribution_value(room)
    built_progress = built_progress_value(room)
    build_carried_energy = build_carried_energy_value(room)
    path_finding_failures = path_finding_failures_value(room)
    destination_blocked = destination_blocked_value(room)
    worker_load_trip_energy_mean = worker_load_trip_energy_mean_value(room)
    worker_load_trip_energy_min = worker_load_trip_energy_min_value(room)
    cpu_used = room_cpu_used_value(room)
    cpu_bucket = room_cpu_bucket_value(room)
    rcl_level = rcl_level_value(room)
    stored_energy = stored_energy_value(room)
    hostile_count = hostile_creep_count(room)
    tower_count = structure_count(room, ("tower", "towers"))
    rampart_count = structure_count(room, ("rampart", "ramparts"))
    defense_backlog = defense_backlog_value(room, construction_backlog)

    record_runtime_room_metrics(
        conn,
        source_artifact=source_artifact,
        tick=tick,
        shard=shard,
        room_name=room_name,
        pending_build_progress=pending_build_progress,
        build_carried_energy=build_carried_energy,
        build_blocked_reason=build_blocked_reason,
        construction_site_count=construction_site_count,
        extension_count=extension_count,
        extension_capacity_contribution=extension_capacity_contribution,
        path_finding_failures=path_finding_failures,
        destination_blocked=destination_blocked,
        worker_load_trip_energy_mean=worker_load_trip_energy_mean,
        worker_load_trip_energy_min=worker_load_trip_energy_min,
        cpu_used=cpu_used,
        cpu_bucket=cpu_bucket,
        rcl_level=rcl_level,
        stored_energy=stored_energy,
        evidence={"line": line_number},
    )
    record_number_if_present(
        conn,
        "survival.owned_spawns",
        spawn_count,
        source_artifact,
        tick,
        shard,
        room_name,
        {"line": line_number},
    )
    record_number_if_present(conn, "creep.worker_count", worker_count, source_artifact, tick, shard, room_name, {})
    record_number_if_present(
        conn,
        "construction.backlog_progress",
        construction_backlog,
        source_artifact,
        tick,
        shard,
        room_name,
        {},
    )
    record_number_if_present(
        conn,
        "construction.build_task_count",
        build_tasks,
        source_artifact,
        tick,
        shard,
        room_name,
        {"taskCounts": task_counts},
    )
    record_number_if_present(
        conn,
        "construction.pending_build_progress",
        pending_build_progress,
        source_artifact,
        tick,
        shard,
        room_name,
        {},
    )
    record_number_if_present(
        conn,
        "construction.site_count",
        construction_site_count,
        source_artifact,
        tick,
        shard,
        room_name,
        {},
    )
    record_number_if_present(
        conn,
        "construction.built_progress",
        built_progress,
        source_artifact,
        tick,
        shard,
        room_name,
        {},
    )
    record_number_if_present(
        conn,
        "construction.build_carried_energy",
        build_carried_energy,
        source_artifact,
        tick,
        shard,
        room_name,
        {},
    )
    if build_blocked_reason is not None:
        record_observation(
            conn,
            "construction.build_blocked_reason",
            None,
            source_artifact=source_artifact,
            tick=tick,
            shard=shard,
            room_name=room_name,
            value_text=build_blocked_reason,
            evidence={"constructionBacklog": construction_backlog},
        )
    record_number_if_present(conn, "economy.extension_count", extension_count, source_artifact, tick, shard, room_name, {})
    record_number_if_present(
        conn,
        "economy.extension_capacity_contribution",
        extension_capacity_contribution,
        source_artifact,
        tick,
        shard,
        room_name,
        {},
    )
    record_number_if_present(
        conn,
        "construction.defense_backlog",
        defense_backlog,
        source_artifact,
        tick,
        shard,
        room_name,
        {},
    )
    record_number_if_present(conn, "defense.hostile_creep_count", hostile_count, source_artifact, tick, shard, room_name, {})
    record_number_if_present(conn, "defense.tower_count", tower_count, source_artifact, tick, shard, room_name, {})
    record_number_if_present(conn, "defense.rampart_count", rampart_count, source_artifact, tick, shard, room_name, {})
    record_number_if_present(conn, "territory.rcl_level", rcl_level, source_artifact, tick, shard, room_name, {})
    record_number_if_present(conn, "cpu.used", cpu_used, source_artifact, tick, shard, room_name, {})
    record_number_if_present(conn, "cpu.bucket", cpu_bucket, source_artifact, tick, shard, room_name, {})
    record_number_if_present(
        conn,
        "creep.path_finding_failures",
        path_finding_failures,
        source_artifact,
        tick,
        shard,
        room_name,
        {},
    )
    record_number_if_present(
        conn,
        "creep.destination_blocked",
        destination_blocked,
        source_artifact,
        tick,
        shard,
        room_name,
        {},
    )
    record_number_if_present(
        conn,
        "creep.worker_load_trip_energy_mean",
        worker_load_trip_energy_mean,
        source_artifact,
        tick,
        shard,
        room_name,
        {},
    )
    record_number_if_present(
        conn,
        "creep.worker_load_trip_energy_min",
        worker_load_trip_energy_min,
        source_artifact,
        tick,
        shard,
        room_name,
        {},
    )

    process_energy_metrics(conn, room, source_artifact, tick, shard, room_name)
    process_low_load_metrics(conn, room, source_artifact, tick, shard, room_name)
    process_stuck_idle_metrics(conn, room, source_artifact, tick, shard, room_name)
    process_upgrade_dominance(
        conn,
        room,
        source_artifact,
        tick,
        shard,
        room_name,
        worker_count,
        upgrade_tasks,
        construction_backlog,
        defense_backlog,
        hostile_count,
    )
    process_construction_findings(
        conn,
        room,
        source_artifact,
        tick,
        room_name,
        construction_backlog,
        build_tasks,
        built_progress,
        build_carried_energy,
        build_blocked_reason,
        defense_backlog,
    )
    process_defense_findings(
        conn,
        room,
        source_artifact,
        tick,
        room_name,
        hostile_count,
        tower_count,
        rampart_count,
        defense_backlog,
        build_tasks,
    )
    process_expansion_spawn_findings(conn, room, source_artifact, tick, room_name, spawn_count)


def record_number_if_present(
    conn: sqlite3.Connection,
    metric_name: str,
    value: float | None,
    source_artifact: str,
    tick: int | None,
    shard: str | None,
    room_name: str,
    evidence: object,
) -> None:
    if value is not None:
        record_observation(
            conn,
            metric_name,
            value,
            source_artifact=source_artifact,
            tick=tick,
            shard=shard,
            room_name=room_name,
            evidence=evidence,
        )


def room_is_claimed(room: dict[str, object]) -> bool:
    controller = as_dict(room.get("controller"))
    if controller.get("my") is True:
        return True
    if text_value(controller.get("owner")) or text_value(controller.get("username")):
        return True
    return room.get("owned") is True or room.get("claimed") is True


def room_spawn_count(room: dict[str, object]) -> float | None:
    direct = first_number(
        room,
        (
            ("spawnCount",),
            ("ownedSpawnCount",),
            ("ownedSpawns",),
            ("spawns", "count"),
            ("spawn", "total"),
            ("structures", "spawn"),
            ("structures", "spawns"),
        ),
    )
    if direct is not None:
        return direct
    spawn_status = room.get("spawnStatus")
    if isinstance(spawn_status, list):
        return float(len(spawn_status))
    spawns = room.get("spawns")
    if isinstance(spawns, list):
        return float(len(spawns))
    return None


def room_worker_count(room: dict[str, object]) -> float | None:
    direct = first_number(
        room,
        (
            ("workerCount",),
            ("ownedCreeps",),
            ("ownedCreepCount",),
            ("creeps",),
            ("creepCount",),
            ("workers", "count"),
        ),
    )
    if direct is not None:
        return direct
    creeps = room.get("creeps")
    if isinstance(creeps, list):
        return float(len(creeps))
    return None


def room_task_counts(room: dict[str, object]) -> dict[str, object]:
    for candidate in (
        room.get("taskCounts"),
        nested_value(room, ("workers", "taskCounts")),
        nested_value(room, ("behavior", "taskCounts")),
        room.get("roleCounts"),
    ):
        if isinstance(candidate, dict):
            return candidate
    return {}


def task_count(task_counts: dict[str, object], name: str) -> float | None:
    value = number_value(task_counts.get(name))
    if value is not None:
        return value
    for key, item in task_counts.items():
        if str(key).lower() == name.lower():
            return number_value(item)
    return None


def construction_backlog_progress(room: dict[str, object]) -> float | None:
    direct = first_number(
        room,
        (
            ("resources", "productiveEnergy", "pendingBuildProgress"),
            ("resources", "pendingBuildProgress"),
            ("construction", "pendingBuildProgress"),
            ("construction", "backlogProgress"),
            ("constructionBacklogProgress",),
            ("backlog", "constructionProgress"),
            ("pendingBuildProgress",),
            ("constructionSiteProgressRemaining",),
        ),
    )
    if direct is not None:
        return direct
    site_count = first_number(
        room,
        (
            ("constructionSiteCount",),
            ("construction", "siteCount"),
            ("constructionSites", "count"),
        ),
    )
    if site_count is not None and site_count > 0:
        return site_count
    priority_text = collect_text(room.get("constructionPriority"))
    if contains_any(priority_text, ("build", "construction", "extension", "spawn", "tower", "rampart")):
        return 1
    return None


def pending_build_progress_value(room: dict[str, object]) -> float | None:
    return first_number(
        room,
        (
            ("pendingBuildProgress",),
            ("resources", "productiveEnergy", "pendingBuildProgress"),
            ("resources", "pendingBuildProgress"),
            ("construction", "pendingBuildProgress"),
        ),
    )


def construction_site_count_value(room: dict[str, object]) -> float | None:
    direct = first_number(
        room,
        (
            ("constructionSiteCount",),
            ("construction", "siteCount"),
            ("constructionSites", "count"),
        ),
    )
    if direct is not None:
        return direct
    for key in ("constructionSites", "sites"):
        value = room.get(key)
        if isinstance(value, list):
            return float(len(value))
    return None


def build_blocked_reason_value(room: dict[str, object]) -> str | None:
    reason = first_text_by_paths(
        room,
        (
            ("buildBlockedReason",),
            ("resources", "productiveEnergy", "buildBlockedReason"),
            ("construction", "buildBlockedReason"),
        ),
    )
    if reason in {"energy_buffer_blocked", "no_construction_sites", "worker_assignment_gap"}:
        return reason
    return None


def extension_count_value(room: dict[str, object]) -> float | None:
    return first_number(
        room,
        (
            ("extensionCount",),
            ("structures", "extensionCount"),
            ("resources", "extensionCount"),
        ),
    )


def extension_capacity_contribution_value(room: dict[str, object]) -> float | None:
    return first_number(
        room,
        (
            ("extensionCapacityContribution",),
            ("structures", "extensionCapacityContribution"),
            ("resources", "extensionCapacityContribution"),
        ),
    )


def path_finding_failures_value(room: dict[str, object]) -> float | None:
    return first_number(
        room,
        (
            ("pathFindingFailures",),
            ("behavior", "pathFindingFailures"),
            ("behavior", "totals", "pathFindingFailures"),
        ),
    )


def destination_blocked_value(room: dict[str, object]) -> float | None:
    return first_number(
        room,
        (
            ("destinationBlocked",),
            ("behavior", "destinationBlocked"),
            ("behavior", "totals", "destinationBlocked"),
        ),
    )


def worker_load_trip_energy_mean_value(room: dict[str, object]) -> float | None:
    return first_number(
        room,
        (
            ("workerLoadEfficiency", "tripEnergyMean"),
            ("workerEfficiency", "tripEnergyMean"),
        ),
    )


def worker_load_trip_energy_min_value(room: dict[str, object]) -> float | None:
    return first_number(
        room,
        (
            ("workerLoadEfficiency", "tripEnergyMin"),
            ("workerEfficiency", "tripEnergyMin"),
        ),
    )


def first_text_by_paths(value: object, paths: tuple[tuple[str, ...], ...]) -> str | None:
    for path in paths:
        found = text_value(nested_value(value, path))
        if found is not None:
            return found
    return None


def built_progress_value(room: dict[str, object]) -> float | None:
    direct = first_number(
        room,
        (
            ("resources", "productiveEnergy", "builtProgress"),
            ("resources", "productiveEnergy", "builtProgressThisTick"),
            ("resources", "events", "builtProgress"),
            ("resources", "events", "buildProgress"),
            ("construction", "builtProgress"),
            ("construction", "builtProgressThisTick"),
            ("buildProgress",),
            ("builtProgress",),
        ),
    )
    if direct is not None:
        return direct
    return find_first_number_by_keys(room, ("builtProgress", "buildProgressThisTick", "builtProgressThisTick"))


def build_carried_energy_value(room: dict[str, object]) -> float | None:
    return first_number(
        room,
        (
            ("resources", "productiveEnergy", "buildCarriedEnergy"),
            ("resources", "buildCarriedEnergy"),
            ("construction", "buildCarriedEnergy"),
            ("buildCarriedEnergy",),
        ),
    ) or find_first_number_by_keys(room, ("buildCarriedEnergy", "builderCarriedEnergy"))


def rcl_level_value(room: dict[str, object]) -> float | None:
    return first_number(room, (("rclLevel",), ("controller", "rclLevel"), ("controller", "level")))


def room_cpu_used_value(room: dict[str, object]) -> float | None:
    return first_number(room, (("cpuUsed",), ("cpu", "used")))


def room_cpu_bucket_value(room: dict[str, object]) -> float | None:
    return first_number(room, (("cpuBucket",), ("cpu", "bucket")))


def hostile_creep_count(room: dict[str, object]) -> float | None:
    return first_number(
        room,
        (
            ("combat", "hostileCreepCount"),
            ("hostileCreepCount",),
            ("hostiles", "creeps"),
            ("defense", "hostileCreepCount"),
        ),
    )


def structure_count(room: dict[str, object], keys: tuple[str, ...]) -> float | None:
    structures = as_dict(room.get("structures"))
    for key in keys:
        value = number_value(structures.get(key))
        if value is not None:
            return value
        listed = structures.get(key)
        if isinstance(listed, list):
            return float(len(listed))
    for key in keys:
        value = first_number(room, ((f"{key}Count",), (key, "count")))
        if value is not None:
            return value
    return None


def defense_backlog_value(room: dict[str, object], construction_backlog: float | None) -> float | None:
    direct = first_number(
        room,
        (
            ("defense", "backlog"),
            ("defense", "constructionBacklog"),
            ("defenseBacklog",),
            ("construction", "defenseBacklog"),
        ),
    )
    if direct is not None:
        return direct
    priority_text = collect_text(room.get("constructionPriority"))
    if contains_any(priority_text, ("tower", "rampart", "defense", "wall")):
        return construction_backlog if construction_backlog is not None else 1
    return None


def process_energy_metrics(
    conn: sqlite3.Connection,
    room: dict[str, object],
    source_artifact: str,
    tick: int | None,
    shard: str | None,
    room_name: str,
) -> None:
    energy_available = first_number(room, (("energyAvailable",), ("energy", "available")))
    stored_energy = stored_energy_value(room)
    worker_carried = first_number(
        room,
        (("resources", "workerCarriedEnergy"), ("workerCarriedEnergy",), ("workers", "carriedEnergy")),
    )
    values = {
        "economy.energy_available": energy_available,
        "economy.stored_energy": stored_energy,
        "economy.worker_carried_energy": worker_carried,
    }
    present = [name for name, value in values.items() if value is not None]
    for metric_name, value in values.items():
        if value is not None:
            record_observation(
                conn,
                metric_name,
                value,
                source_artifact=source_artifact,
                tick=tick,
                shard=shard,
                room_name=room_name,
                unit="energy",
            )
    if present:
        record_observation(
            conn,
            "economy.energy_telemetry",
            1,
            source_artifact=source_artifact,
            tick=tick,
            shard=shard,
            room_name=room_name,
            evidence={"presentMetrics": present},
        )
    else:
        record_coverage_gap(
            conn,
            metric_name="economy.energy_telemetry",
            category="resource economy",
            severity="critical",
            source_artifact=source_artifact,
            tick=tick,
            room_name=room_name,
            gap_type="missing_energy_fields",
            message="no energyAvailable, storedEnergy, or workerCarriedEnergy fields were present",
        )


def stored_energy_value(room: dict[str, object]) -> float | None:
    return first_number(room, (("resources", "storedEnergy"), ("storedEnergy",), ("storage", "energy")))


def process_low_load_metrics(
    conn: sqlite3.Connection,
    room: dict[str, object],
    source_artifact: str,
    tick: int | None,
    shard: str | None,
    room_name: str,
) -> None:
    low_count = first_number(
        room,
        (
            ("behavior", "lowLoadReturnCount"),
            ("workerEfficiency", "lowLoadReturnCount"),
            ("lowLoadReturnCount",),
            ("lowLoadReturns",),
        ),
    )
    return_energy = first_number(
        room,
        (
            ("behavior", "lastReturnEnergy"),
            ("workerEfficiency", "lastReturnEnergy"),
            ("lastReturnEnergy",),
            ("returnEnergy",),
            ("returnedEnergy",),
            ("lowLoadReturnEnergy",),
        ),
    )
    return_capacity = first_number(
        room,
        (
            ("behavior", "returnCapacity"),
            ("workerEfficiency", "returnCapacity"),
            ("returnCapacity",),
            ("carryCapacity",),
            ("returnedCapacity",),
        ),
    )
    load_factor = first_number(
        room,
        (
            ("behavior", "returnLoadFactor"),
            ("workerEfficiency", "returnLoadFactor"),
            ("returnLoadFactor",),
            ("workerReturnLoadFactor",),
            ("loadFactor",),
        ),
    )
    if load_factor is None and return_energy is not None and return_capacity is not None and return_capacity > 0:
        load_factor = round(return_energy / return_capacity, 4)
    if low_count is None and load_factor is not None and load_factor <= 0.10:
        low_count = 1
    trip_energy_mean = worker_load_trip_energy_mean_value(room)
    trip_energy_min = worker_load_trip_energy_min_value(room)

    if low_count is None and load_factor is None and trip_energy_mean is None and trip_energy_min is None:
        record_coverage_gap(
            conn,
            metric_name="creep.low_load_return_count",
            category="creep efficiency",
            severity="warning",
            source_artifact=source_artifact,
            tick=tick,
            room_name=room_name,
            gap_type="missing_low_load_return_fields",
            message="low-load return/load-factor fields were not present",
        )
        return

    if low_count is not None:
        record_observation(
            conn,
            "creep.low_load_return_count",
            low_count,
            source_artifact=source_artifact,
            tick=tick,
            shard=shard,
            room_name=room_name,
            evidence={"returnEnergy": return_energy, "returnCapacity": return_capacity, "loadFactor": load_factor},
        )
    if load_factor is not None:
        record_observation(
            conn,
            "creep.return_load_factor",
            load_factor,
            source_artifact=source_artifact,
            tick=tick,
            shard=shard,
            room_name=room_name,
            evidence={"returnEnergy": return_energy, "returnCapacity": return_capacity},
        )

    low_trip_energy = (trip_energy_min is not None and trip_energy_min < 10) or (
        trip_energy_mean is not None and trip_energy_mean < 10
    )
    if (low_count is not None and low_count > 0) or (load_factor is not None and load_factor <= 0.10) or low_trip_energy:
        record_finding(
            conn,
            finding_key=f"low-load-return:{room_name}:{tick}",
            category="low-load-return",
            severity="warning",
            metric_name="creep.low_load_return_count",
            source_artifact=source_artifact,
            tick=tick,
            room_name=room_name,
            evidence={
                "lowLoadReturnCount": low_count,
                "returnEnergy": return_energy,
                "returnCapacity": return_capacity,
                "loadFactor": load_factor,
                "tripEnergyMean": trip_energy_mean,
                "tripEnergyMin": trip_energy_min,
            },
            recommendation="Audit worker return/transfer selection and suppress low-load trips outside emergency recovery.",
        )


def process_stuck_idle_metrics(
    conn: sqlite3.Connection,
    room: dict[str, object],
    source_artifact: str,
    tick: int | None,
    shard: str | None,
    room_name: str,
) -> None:
    idle_count = first_number(
        room,
        (("behavior", "idleCount"), ("behavior", "idleTicks"), ("idleCount",), ("idleTicks",)),
    )
    stuck_ticks = first_number(
        room,
        (
            ("behavior", "totals", "stuckTicks"),
            ("behavior", "stuckTicks"),
            ("behavior", "actionlessTicks"),
            ("stuckTicks",),
            ("actionlessTicks",),
            ("stuckCreepCount",),
        ),
    )
    path_finding_failures = path_finding_failures_value(room)
    destination_blocked = destination_blocked_value(room)
    if idle_count is not None:
        record_observation(
            conn,
            "creep.idle_count",
            idle_count,
            source_artifact=source_artifact,
            tick=tick,
            shard=shard,
            room_name=room_name,
        )
    if stuck_ticks is not None:
        record_observation(
            conn,
            "creep.stuck_ticks",
            stuck_ticks,
            source_artifact=source_artifact,
            tick=tick,
            shard=shard,
            room_name=room_name,
        )
    if idle_count is None and stuck_ticks is None and path_finding_failures is None and destination_blocked is None:
        record_coverage_gap(
            conn,
            metric_name="creep.stuck_ticks",
            category="creep efficiency",
            severity="warning",
            source_artifact=source_artifact,
            tick=tick,
            room_name=room_name,
            gap_type="missing_stuck_actionless_fields",
            message="idle/stuck/actionless fields were not present",
        )
    if path_finding_failures is not None and path_finding_failures > 0:
        record_finding(
            conn,
            finding_key=f"path-finding-failure:{room_name}:{tick}",
            category="stuck-actionless",
            severity="warning",
            metric_name="creep.path_finding_failures",
            source_artifact=source_artifact,
            tick=tick,
            room_name=room_name,
            evidence={
                "pathFindingFailures": path_finding_failures,
                "destinationBlocked": destination_blocked,
                "stuckTicks": stuck_ticks,
            },
            recommendation="Inspect pathing and target selection for blocked destinations before long stuck windows accumulate.",
            promotion_state="promote-if-repeated",
        )
    if stuck_ticks is not None and stuck_ticks >= 50:
        record_finding(
            conn,
            finding_key=f"stuck-actionless:{room_name}:{tick}",
            category="stuck-actionless",
            severity="critical",
            metric_name="creep.stuck_ticks",
            source_artifact=source_artifact,
            tick=tick,
            room_name=room_name,
            evidence={"stuckTicks": stuck_ticks, "idleCount": idle_count},
            recommendation="Inspect creep task/path state and add recovery for long actionless windows.",
            promotion_state="promote-if-repeated",
        )


def process_upgrade_dominance(
    conn: sqlite3.Connection,
    room: dict[str, object],
    source_artifact: str,
    tick: int | None,
    shard: str | None,
    room_name: str,
    worker_count: float | None,
    upgrade_tasks: float | None,
    construction_backlog: float | None,
    defense_backlog: float | None,
    hostile_count: float | None,
) -> None:
    if worker_count is None or worker_count <= 0 or upgrade_tasks is None:
        return
    ratio = round(upgrade_tasks / worker_count, 4)
    record_observation(
        conn,
        "behavior.upgrade_dominance_ratio",
        ratio,
        source_artifact=source_artifact,
        tick=tick,
        shard=shard,
        room_name=room_name,
        evidence={"workerCount": worker_count, "upgradeTasks": upgrade_tasks},
    )
    urgent_backlog = (construction_backlog is not None and construction_backlog > 0) or (
        defense_backlog is not None and defense_backlog > 0
    ) or (hostile_count is not None and hostile_count > 0)
    if ratio >= 0.60 and urgent_backlog:
        record_finding(
            conn,
            finding_key=f"upgrade-dominant:{room_name}:{tick}",
            category="upgrade-dominant-backlog",
            severity="warning",
            metric_name="behavior.upgrade_dominance_ratio",
            source_artifact=source_artifact,
            tick=tick,
            room_name=room_name,
            evidence={
                "upgradeDominanceRatio": ratio,
                "constructionBacklog": construction_backlog,
                "defenseBacklog": defense_backlog,
                "hostileCreepCount": hostile_count,
            },
            recommendation="Reduce upgrade assignment while capacity, defense, or construction backlog remains.",
        )


def process_construction_findings(
    conn: sqlite3.Connection,
    room: dict[str, object],
    source_artifact: str,
    tick: int | None,
    room_name: str,
    construction_backlog: float | None,
    build_tasks: float | None,
    built_progress: float | None,
    build_carried_energy: float | None,
    build_blocked_reason: str | None,
    defense_backlog: float | None,
) -> None:
    if construction_backlog is None or construction_backlog <= 0:
        return
    if built_progress is None:
        record_coverage_gap(
            conn,
            metric_name="construction.built_progress",
            category="construction/infrastructure",
            severity="warning",
            source_artifact=source_artifact,
            tick=tick,
            room_name=room_name,
            gap_type="missing_build_progress",
            message="construction backlog exists but build progress telemetry is missing",
        )
    if build_carried_energy is None:
        record_coverage_gap(
            conn,
            metric_name="construction.build_carried_energy",
            category="construction/infrastructure",
            severity="warning",
            source_artifact=source_artifact,
            tick=tick,
            room_name=room_name,
            gap_type="missing_build_carried_energy",
            message="construction backlog exists but build-carried energy telemetry is missing",
        )
    if build_blocked_reason is None:
        record_coverage_gap(
            conn,
            metric_name="construction.build_blocked_reason",
            category="construction/infrastructure",
            severity="warning",
            source_artifact=source_artifact,
            tick=tick,
            room_name=room_name,
            gap_type="missing_build_blocked_reason",
            message="construction backlog exists but buildBlockedReason telemetry is missing",
        )

    build_zero = build_tasks == 0 or build_tasks is None
    progress_zero = built_progress == 0 or built_progress is None
    build_energy_zero = build_carried_energy == 0 or build_carried_energy is None
    if build_zero and progress_zero and build_energy_zero:
        high_urgency = defense_backlog is not None and defense_backlog > 0
        priority_text = collect_text(room.get("constructionPriority"))
        if contains_any(priority_text, ("high", "urgent", "tower", "rampart", "defense")):
            high_urgency = True
        record_finding(
            conn,
            finding_key=f"build-zero-with-backlog:{room_name}:{tick}",
            category="stalled-construction",
            severity="critical" if high_urgency else "warning",
            metric_name="construction.backlog_progress",
            source_artifact=source_artifact,
            tick=tick,
            room_name=room_name,
            evidence={
                "constructionBacklog": construction_backlog,
                "buildTaskCount": build_tasks,
                "builtProgress": built_progress,
                "buildCarriedEnergy": build_carried_energy,
                "buildBlockedReason": build_blocked_reason,
                "defenseBacklog": defense_backlog,
            },
            recommendation="Assign builder work or clear stale construction plans when backlog cannot progress.",
            promotion_state="promote-if-repeated-or-severe",
        )


def process_defense_findings(
    conn: sqlite3.Connection,
    room: dict[str, object],
    source_artifact: str,
    tick: int | None,
    room_name: str,
    hostile_count: float | None,
    tower_count: float | None,
    rampart_count: float | None,
    defense_backlog: float | None,
    build_tasks: float | None,
) -> None:
    threatened = hostile_count is not None and hostile_count > 0
    defense_pending = defense_backlog is not None and defense_backlog > 0
    if not threatened and not defense_pending:
        return
    if tower_count is None and rampart_count is None:
        record_coverage_gap(
            conn,
            metric_name="defense.tower_count",
            category="defense readiness",
            severity="critical" if threatened else "warning",
            source_artifact=source_artifact,
            tick=tick,
            room_name=room_name,
            gap_type="missing_defense_infra_fields",
            message="threat/defense backlog exists but tower/rampart telemetry is missing",
        )
        return
    missing_tower = tower_count is not None and tower_count <= 0
    missing_rampart = rampart_count is not None and rampart_count <= 0
    if missing_tower or (defense_pending and missing_rampart):
        record_finding(
            conn,
            finding_key=f"missing-defense-infra:{room_name}:{tick}",
            category="missing-late-defense-construction",
            severity="critical" if threatened else "warning",
            metric_name="construction.defense_backlog",
            source_artifact=source_artifact,
            tick=tick,
            room_name=room_name,
            evidence={
                "hostileCreepCount": hostile_count,
                "towerCount": tower_count,
                "rampartCount": rampart_count,
                "defenseBacklog": defense_backlog,
                "buildTaskCount": build_tasks,
            },
            recommendation="Prioritize tower/rampart/defense construction before discretionary upgrade work.",
            promotion_state="promote-if-severe-or-repeated",
        )


def process_expansion_spawn_findings(
    conn: sqlite3.Connection,
    room: dict[str, object],
    source_artifact: str,
    tick: int | None,
    room_name: str,
    spawn_count: float | None,
) -> None:
    if not room_is_claimed(room) or spawn_count != 0:
        return
    claim_age = first_number(
        room,
        (
            ("ticksSinceClaim",),
            ("claimAgeTicks",),
            ("claimedAgeTicks",),
            ("roomClaimAge",),
            ("ageTicks",),
            ("territory", "claimAgeTicks"),
        ),
    )
    if claim_age is None:
        record_coverage_gap(
            conn,
            metric_name="survival.claimed_room_without_spawn_age_ticks",
            category="survival/ownership",
            severity="warning",
            source_artifact=source_artifact,
            tick=tick,
            room_name=room_name,
            gap_type="missing_claim_age",
            message="claimed room has 0 spawns but claim age/grace telemetry is missing",
        )
        return
    record_observation(
        conn,
        "survival.claimed_room_without_spawn_age_ticks",
        claim_age,
        source_artifact=source_artifact,
        tick=tick,
        room_name=room_name,
        unit="ticks",
        evidence={"spawnCount": spawn_count, "graceTicks": EXPANSION_SPAWN_GRACE_TICKS},
    )
    if claim_age >= EXPANSION_SPAWN_GRACE_TICKS:
        record_finding(
            conn,
            finding_key=f"claimed-room-zero-spawns:{room_name}:{tick}",
            category="claimed-expansion-zero-spawn",
            severity="critical",
            metric_name="survival.claimed_room_without_spawn_age_ticks",
            source_artifact=source_artifact,
            tick=tick,
            room_name=room_name,
            evidence={"claimAgeTicks": claim_age, "spawnCount": spawn_count, "graceTicks": EXPANSION_SPAWN_GRACE_TICKS},
            recommendation="Recover expansion spawn construction or abandon/demote the failed claim.",
            promotion_state="promote-immediately",
        )


def process_dataset_gate(
    conn: sqlite3.Connection,
    payload: dict[str, object],
    source_artifact: str,
    stats: dict[str, int],
) -> None:
    gate_id = text_value(payload.get("gateId"))
    dataset_gate = as_dict(payload.get("datasetGate"))
    quality = as_dict(payload.get("quality_checks")) or as_dict(payload.get("qualityChecks"))
    status = (
        text_value(dataset_gate.get("status"))
        or text_value(payload.get("datasetGateStatus"))
        or ("pass" if payload.get("ok") is True else "fail" if payload.get("ok") is False else "unknown")
    )
    status_value = 1 if status == "pass" else 0 if status in ("fail", "error") else None
    record_dataset_gate_metric(
        conn,
        gate_id=gate_id,
        status=status,
        metric_name="rl.dataset_gate.status",
        value=status_value,
        source_artifact=source_artifact,
        evidence={"gateId": gate_id, "status": status},
    )
    for metric_name, value in (
        ("rl.dataset_gate.sample_count", dataset_gate.get("sampleCount") or payload.get("sampleCount")),
        ("rl.dataset_gate.quality_samples_rejected", quality.get("samples_rejected")),
        ("rl.dataset_gate.quality_samples_accepted", quality.get("samples_accepted")),
    ):
        numeric = number_value(value)
        if numeric is not None:
            record_dataset_gate_metric(
                conn,
                gate_id=gate_id,
                status=status,
                metric_name=metric_name,
                value=numeric,
                source_artifact=source_artifact,
            )
    if status == "fail" or number_value(quality.get("samples_rejected")) not in (None, 0):
        record_finding(
            conn,
            finding_key=f"rl-dataset-gate-rejected:{gate_id or source_artifact}",
            category="rl-gate-rejection",
            severity="warning",
            metric_name="rl.dataset_gate.status",
            source_artifact=source_artifact,
            evidence={
                "gateId": gate_id,
                "status": status,
                "qualitySamplesRejected": quality.get("samples_rejected"),
                "blockingReasons": payload.get("blockingReasons"),
            },
            recommendation="Inspect rejected RL samples/gate checks before training or rollout advances.",
            promotion_state="promote-if-repeated",
        )
    stats["dataset_gate_artifacts"] += 1


def process_training_report(
    conn: sqlite3.Connection,
    payload: dict[str, object],
    source_artifact: str,
    stats: dict[str, int],
) -> None:
    report_id = text_value(payload.get("reportId"))
    for result in as_list(payload.get("variantResults")):
        if not isinstance(result, dict):
            continue
        variant_id = text_value(result.get("variantId"))
        sample_count = number_value(result.get("sampleCount"))
        record_training_metric(
            conn,
            report_id=report_id,
            variant_id=variant_id,
            metric_name="rl.training.execution_sample_count",
            value=sample_count,
            source_artifact=source_artifact,
        )
        reward = as_dict(result.get("reward"))
        reward_tuple = as_list(reward.get("tuple"))
        for index, metric_name in enumerate(
            (
                "rl.training.reward_territory",
                "rl.training.reward_resources",
                "rl.training.reward_kills",
            )
        ):
            if index < len(reward_tuple):
                record_training_metric(
                    conn,
                    report_id=report_id,
                    variant_id=variant_id,
                    metric_name=metric_name,
                    value=number_value(reward_tuple[index]),
                    source_artifact=source_artifact,
                    evidence={"rewardTuple": reward_tuple},
                )

    incumbent_ids = [item for item in as_list(payload.get("incumbentStrategyIds")) if isinstance(item, str)]
    ranking = [item for item in as_list(payload.get("ranking")) if isinstance(item, dict)]
    if ranking and incumbent_ids:
        best = ranking[0]
        candidate_id = text_value(best.get("variantId"))
        best_tuple = reward_tuple_from_ranking_item(best)
        incumbent = first_incumbent_ranking(ranking, incumbent_ids)
        incumbent_tuple = reward_tuple_from_ranking_item(incumbent) if incumbent else []
        for index, metric_name in enumerate(
            (
                "rl.policy.advantage_territory",
                "rl.policy.advantage_resources",
                "rl.policy.advantage_kills",
            )
        ):
            if index < len(best_tuple) and index < len(incumbent_tuple):
                record_policy_advantage(
                    conn,
                    report_id=report_id,
                    candidate_id=candidate_id,
                    incumbent_id=text_value(incumbent.get("variantId")) if incumbent else None,
                    metric_name=metric_name,
                    value=number_value(best_tuple[index]) - number_value(incumbent_tuple[index]),
                    directionality="higher is better",
                    source_artifact=source_artifact,
                    evidence={"bestRewardTuple": best_tuple, "incumbentRewardTuple": incumbent_tuple},
                )
    for metric_name, raw_value in (
        ("rl.training.changed_top_count", payload.get("changedTopCount")),
        ("rl.training.ranking_diff_count", payload.get("rankingDiffCount")),
    ):
        value = number_value(raw_value)
        if value is not None:
            record_training_metric(
                conn,
                report_id=report_id,
                variant_id=None,
                metric_name=metric_name,
                value=value,
                source_artifact=source_artifact,
            )
    stats["training_artifacts"] += 1


def reward_tuple_from_ranking_item(item: dict[str, object] | None) -> list[float]:
    if not isinstance(item, dict):
        return []
    raw_tuple = as_list(item.get("rewardTuple"))
    if not raw_tuple:
        raw_tuple = as_list(as_dict(item.get("reward")).get("tuple"))
    values: list[float] = []
    for raw_value in raw_tuple:
        value = number_value(raw_value)
        if value is not None:
            values.append(value)
    return values


def first_incumbent_ranking(ranking: list[dict[str, object]], incumbent_ids: list[str]) -> dict[str, object] | None:
    for item in ranking:
        if text_value(item.get("variantId")) in incumbent_ids:
            return item
    return None


def process_iteration_payload(
    conn: sqlite3.Connection,
    payload: dict[str, object],
    source_artifact: str,
    stats: dict[str, int],
) -> None:
    decision = text_value(payload.get("decision")) or text_value(payload.get("status")) or "observed"
    decision_key = (
        text_value(payload.get("decisionId"))
        or text_value(payload.get("rolloutId"))
        or text_value(payload.get("candidateId"))
        or f"decision:{source_artifact}"
    )
    blocking = as_list(payload.get("blockingReasons"))
    rationale = "decision artifact ingested"
    if blocking:
        rationale = "decision has blocking reasons"
    record_iteration_decision(
        conn,
        decision_key=decision_key,
        status=decision,
        source_artifact=source_artifact,
        rationale=rationale,
        evidence={"blockingReasons": blocking[:10], "feedbackIngestion": payload.get("feedbackIngestion")},
    )
    stats["iteration_decisions"] += 1


def summarize_database(db_path: Path, output_format: str = "text") -> str:
    initialize_database(db_path)
    with connect_database(db_path) as conn:
        counts = {}
        for table in (
            "metric_definitions",
            "metric_observations",
            "runtime_room_metrics",
            "gameplay_behavior_findings",
            "metric_coverage_gaps",
            "rl_dataset_gate_metrics",
            "rl_training_execution_metrics",
            "rl_policy_advantage_metrics",
            "metric_iteration_decisions",
        ):
            counts[table] = int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        severity_rows = conn.execute(
            """
            SELECT severity, COUNT(*) AS count
            FROM gameplay_behavior_findings
            GROUP BY severity
            ORDER BY severity
            """
        ).fetchall()
        gap_rows = conn.execute(
            """
            SELECT metric_name, COUNT(*) AS count
            FROM metric_coverage_gaps
            GROUP BY metric_name
            ORDER BY count DESC, metric_name
            LIMIT 10
            """
        ).fetchall()
        latest_tick_row = conn.execute("SELECT MAX(tick) AS latest_tick FROM runtime_room_metrics").fetchone()
        latest_tick = latest_tick_row["latest_tick"] if latest_tick_row is not None else None
        if latest_tick is None:
            runtime_room_row = None
        else:
            runtime_room_row = conn.execute(
                """
                SELECT
                  COUNT(*) AS room_samples,
                  SUM(COALESCE(pending_build_progress, 0)) AS pending_build_progress,
                  SUM(COALESCE(build_carried_energy, 0)) AS build_carried_energy,
                  SUM(COALESCE(construction_site_count, 0)) AS construction_site_count,
                  SUM(COALESCE(extension_count, 0)) AS extension_count,
                  SUM(COALESCE(extension_capacity_contribution, 0)) AS extension_capacity_contribution,
                  SUM(COALESCE(path_finding_failures, 0)) AS path_finding_failures,
                  SUM(COALESCE(destination_blocked, 0)) AS destination_blocked,
                  AVG(worker_load_trip_energy_mean) AS worker_load_trip_energy_mean,
                  MIN(worker_load_trip_energy_min) AS worker_load_trip_energy_min,
                  AVG(cpu_used) AS avg_cpu_used,
                  MIN(cpu_bucket) AS min_cpu_bucket,
                  MAX(rcl_level) AS max_rcl_level,
                  SUM(COALESCE(stored_energy, 0)) AS stored_energy
                FROM runtime_room_metrics
                WHERE tick = ?
                """,
                (latest_tick,),
            ).fetchone()

    if output_format == "json":
        latest_runtime_room_metrics = {}
        if runtime_room_row is not None:
            latest_runtime_room_metrics = {
                "tick": latest_tick,
                "roomSamples": runtime_room_row["room_samples"],
                "pendingBuildProgress": runtime_room_row["pending_build_progress"],
                "buildCarriedEnergy": runtime_room_row["build_carried_energy"],
                "constructionSiteCount": runtime_room_row["construction_site_count"],
                "extensionCount": runtime_room_row["extension_count"],
                "extensionCapacityContribution": runtime_room_row["extension_capacity_contribution"],
                "pathFindingFailures": runtime_room_row["path_finding_failures"],
                "destinationBlocked": runtime_room_row["destination_blocked"],
                "workerLoadTripEnergyMean": runtime_room_row["worker_load_trip_energy_mean"],
                "workerLoadTripEnergyMin": runtime_room_row["worker_load_trip_energy_min"],
                "avgCpuUsed": runtime_room_row["avg_cpu_used"],
                "minCpuBucket": runtime_room_row["min_cpu_bucket"],
                "maxRclLevel": runtime_room_row["max_rcl_level"],
                "storedEnergy": runtime_room_row["stored_energy"],
            }
        return json.dumps(
            {
                "db": str(db_path),
                "counts": counts,
                "findingsBySeverity": {row["severity"]: row["count"] for row in severity_rows},
                "topCoverageGaps": {row["metric_name"]: row["count"] for row in gap_rows},
                "latestRuntimeRoomMetrics": latest_runtime_room_metrics,
            },
            indent=2,
            sort_keys=True,
        )

    lines = [f"RL metrics DB: {db_path}"]
    for table, count in counts.items():
        lines.append(f"{table}: {count}")
    if severity_rows:
        lines.append("findings_by_severity:")
        for row in severity_rows:
            lines.append(f"  {row['severity']}: {row['count']}")
    if gap_rows:
        lines.append("top_coverage_gaps:")
        for row in gap_rows:
            lines.append(f"  {row['metric_name']}: {row['count']}")
    if runtime_room_row is not None:
        lines.append("latest_runtime_room_metrics:")
        lines.append(f"  tick: {latest_tick}")
        lines.append(f"  room_samples: {runtime_room_row['room_samples']}")
        lines.append(f"  pendingBuildProgress: {runtime_room_row['pending_build_progress']}")
        lines.append(f"  buildCarriedEnergy: {runtime_room_row['build_carried_energy']}")
        lines.append(f"  constructionSiteCount: {runtime_room_row['construction_site_count']}")
        lines.append(f"  extensionCount: {runtime_room_row['extension_count']}")
        lines.append(f"  extensionCapacityContribution: {runtime_room_row['extension_capacity_contribution']}")
        lines.append(f"  pathFindingFailures: {runtime_room_row['path_finding_failures']}")
        lines.append(f"  destinationBlocked: {runtime_room_row['destination_blocked']}")
        lines.append(f"  workerLoadTripEnergyMean: {runtime_room_row['worker_load_trip_energy_mean']}")
        lines.append(f"  workerLoadTripEnergyMin: {runtime_room_row['worker_load_trip_energy_min']}")
        lines.append(f"  avgCpuUsed: {runtime_room_row['avg_cpu_used']}")
        lines.append(f"  minCpuBucket: {runtime_room_row['min_cpu_bucket']}")
        lines.append(f"  maxRclLevel: {runtime_room_row['max_rcl_level']}")
        lines.append(f"  storedEnergy: {runtime_room_row['stored_energy']}")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Ingest Screeps RL gameplay metrics into SQLite.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init", help="initialize the metrics SQLite schema")
    init_parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)

    ingest_parser = subparsers.add_parser("ingest-artifacts", help="ingest local runtime/RL artifact files")
    ingest_parser.add_argument("paths", nargs="*", type=Path, help="artifact files/directories to scan")
    ingest_parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    ingest_parser.add_argument("--max-file-bytes", type=int, default=DEFAULT_MAX_FILE_BYTES)

    summarize_parser = subparsers.add_parser("summarize", help="summarize stored metrics")
    summarize_parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    summarize_parser.add_argument("--format", choices=("text", "json"), default="text")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "init":
        result = initialize_database(args.db)
        print(json.dumps({"ok": True, "db": str(args.db), **result}, sort_keys=True))
        return 0
    if args.command == "ingest-artifacts":
        result = ingest_artifacts(args.db, args.paths, max_file_bytes=args.max_file_bytes)
        print(json.dumps({"ok": True, "db": str(args.db), **result}, sort_keys=True))
        return 0
    if args.command == "summarize":
        print(summarize_database(args.db, output_format=args.format))
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
