#!/usr/bin/env python3
"""Scale classification gates for offline Screeps RL training batches."""

from __future__ import annotations

import math
from typing import Any


SMOKE_ENVIRONMENT_ROWS = 50
SMOKE_SIMULATOR_TICKS = 50_000
VALIDATION_ENVIRONMENT_ROWS = 200
VALIDATION_SIMULATOR_TICKS = 200_000
NORMAL_SCALE_ENVIRONMENT_ROWS = 400
NORMAL_SCALE_SIMULATOR_TICKS = 400_000
LARGE_CAMPAIGN_ENVIRONMENT_ROWS = 800
LARGE_CAMPAIGN_SIMULATOR_TICKS = 1_600_000

BATCH_CLASS_SMOKE = "smoke"
BATCH_CLASS_INTERMEDIATE = "intermediate"
BATCH_CLASS_VALIDATION = "validation"
BATCH_CLASS_NORMAL_SCALE = "normal-scale"
BATCH_CLASS_LARGE_CAMPAIGN = "large-campaign"
SCALE_FIRST_BATCH_CLASSES = {
    BATCH_CLASS_VALIDATION,
    BATCH_CLASS_NORMAL_SCALE,
    BATCH_CLASS_LARGE_CAMPAIGN,
}

JsonObject = dict[str, Any]


def classify_batch_scale(environment_rows: int, simulator_ticks: int) -> str:
    """Classify a training batch from executed environment rows and simulator ticks."""
    rows = require_non_negative_int(environment_rows, "environment_rows")
    ticks = require_non_negative_int(simulator_ticks, "simulator_ticks")
    if rows < SMOKE_ENVIRONMENT_ROWS or ticks < SMOKE_SIMULATOR_TICKS:
        return BATCH_CLASS_SMOKE
    if rows >= LARGE_CAMPAIGN_ENVIRONMENT_ROWS and ticks >= LARGE_CAMPAIGN_SIMULATOR_TICKS:
        return BATCH_CLASS_LARGE_CAMPAIGN
    if rows >= NORMAL_SCALE_ENVIRONMENT_ROWS and ticks >= NORMAL_SCALE_SIMULATOR_TICKS:
        return BATCH_CLASS_NORMAL_SCALE
    if rows >= VALIDATION_ENVIRONMENT_ROWS and ticks >= VALIDATION_SIMULATOR_TICKS:
        return BATCH_CLASS_VALIDATION
    return BATCH_CLASS_INTERMEDIATE


def scale_first_eligible(batch_class: str) -> bool:
    return batch_class in SCALE_FIRST_BATCH_CLASSES


def build_batch_scale_summary(
    *,
    environment_rows: int,
    simulator_ticks: int,
    wall_clock_seconds: float | int | None = None,
    asg_active_seconds: float | int | None = None,
    cost_estimate: Any | None = None,
    basis: str | None = None,
) -> JsonObject:
    """Return report-ready batch scale evidence with optional utilization fields."""
    rows = require_non_negative_int(environment_rows, "environment_rows")
    ticks = require_non_negative_int(simulator_ticks, "simulator_ticks")
    batch_class = classify_batch_scale(rows, ticks)
    summary: JsonObject = {
        "batchClass": batch_class,
        "environmentRows": rows,
        "simulatorTicks": ticks,
        "scaleFirstEligible": scale_first_eligible(batch_class),
        "scaleFirstMinimumClass": BATCH_CLASS_VALIDATION,
        "thresholds": batch_scale_thresholds(),
    }
    if basis:
        summary["basis"] = basis
    wall_seconds = non_negative_float(wall_clock_seconds)
    if wall_seconds is not None:
        summary["wallClockSeconds"] = round_float(wall_seconds)
    active_seconds = non_negative_float(asg_active_seconds)
    if active_seconds is not None:
        summary["asgActiveSeconds"] = round_float(active_seconds)
    if wall_seconds is not None and active_seconds is not None and active_seconds > 0:
        summary["utilizationRatio"] = round_float(wall_seconds / active_seconds)
    if cost_estimate is not None:
        summary["costEstimate"] = cost_estimate
    return summary


def batch_scale_thresholds() -> JsonObject:
    return {
        BATCH_CLASS_SMOKE: {
            "environmentRows": f"<{SMOKE_ENVIRONMENT_ROWS}",
            "simulatorTicks": f"<{SMOKE_SIMULATOR_TICKS}",
            "operator": "OR",
        },
        BATCH_CLASS_INTERMEDIATE: {
            "environmentRows": f">={SMOKE_ENVIRONMENT_ROWS}",
            "simulatorTicks": f">={SMOKE_SIMULATOR_TICKS}",
            "operator": (
                f"AND with (environmentRows <{VALIDATION_ENVIRONMENT_ROWS} "
                f"OR simulatorTicks <{VALIDATION_SIMULATOR_TICKS})"
            ),
        },
        BATCH_CLASS_VALIDATION: {
            "environmentRows": f">={VALIDATION_ENVIRONMENT_ROWS}",
            "simulatorTicks": f">={VALIDATION_SIMULATOR_TICKS}",
            "operator": "AND",
        },
        BATCH_CLASS_NORMAL_SCALE: {
            "environmentRows": f">={NORMAL_SCALE_ENVIRONMENT_ROWS}",
            "simulatorTicks": f">={NORMAL_SCALE_SIMULATOR_TICKS}",
            "operator": "AND",
        },
        BATCH_CLASS_LARGE_CAMPAIGN: {
            "environmentRows": f">={LARGE_CAMPAIGN_ENVIRONMENT_ROWS}",
            "simulatorTicks": f">={LARGE_CAMPAIGN_SIMULATOR_TICKS}",
            "operator": "AND",
        },
    }


def require_non_negative_int(value: Any, label: str) -> int:
    parsed = non_negative_int(value)
    if parsed is None:
        raise ValueError(f"{label} must be a non-negative integer")
    return parsed


def non_negative_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, float) and math.isfinite(value) and value.is_integer() and value >= 0:
        return int(value)
    if isinstance(value, str):
        try:
            parsed = int(value)
        except ValueError:
            return None
        return parsed if parsed >= 0 else None
    return None


def non_negative_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value) and value >= 0:
        return float(value)
    if isinstance(value, str):
        try:
            parsed = float(value)
        except ValueError:
            return None
        return parsed if math.isfinite(parsed) and parsed >= 0 else None
    return None


def round_float(value: float) -> float:
    return round(float(value), 6)
