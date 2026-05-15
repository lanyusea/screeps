#!/usr/bin/env python3
"""Shared official Screeps world profile defaults."""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


WORLD_PROFILE_ENV = "SCREEPS_WORLD_PROFILE"
PERSISTENT_PROFILE = "persistent"
SEASONAL_PROFILE = "seasonal"
VALID_WORLD_PROFILES = (PERSISTENT_PROFILE, SEASONAL_PROFILE)


@dataclass(frozen=True)
class WorldProfileDefaults:
    name: str
    api_url: str
    shard: str
    monitor_out_dir: Path
    monitor_state_file: Path
    monitor_cache_dir: Path
    runtime_summary_out_dir: Path
    console_capture_out_dir: Path


PERSISTENT_DEFAULTS = WorldProfileDefaults(
    name=PERSISTENT_PROFILE,
    api_url="https://screeps.com",
    shard="shardX",
    monitor_out_dir=Path("/root/screeps/runtime-artifacts/screeps-monitor"),
    monitor_state_file=Path("/root/.hermes/screeps-runtime-monitor/state.json"),
    monitor_cache_dir=Path("/root/.hermes/screeps-runtime-monitor/terrain-cache"),
    runtime_summary_out_dir=Path("/root/screeps/runtime-artifacts/runtime-summary-console"),
    console_capture_out_dir=Path("/root/screeps/runtime-artifacts/runtime-summary-console"),
)

SEASONAL_DEFAULTS = WorldProfileDefaults(
    name=SEASONAL_PROFILE,
    api_url="https://screeps.com/season",
    shard="shardSeason",
    monitor_out_dir=Path("/root/screeps/runtime-artifacts/seasonal/screeps-monitor"),
    monitor_state_file=Path("/root/.hermes/screeps-seasonal-runtime-monitor/state.json"),
    monitor_cache_dir=Path("/root/.hermes/screeps-seasonal-runtime-monitor/terrain-cache"),
    runtime_summary_out_dir=Path("/root/screeps/runtime-artifacts/seasonal/runtime-summary-console"),
    console_capture_out_dir=Path("/root/screeps/runtime-artifacts/seasonal/runtime-summary-console"),
)

WORLD_PROFILE_DEFAULTS = {
    PERSISTENT_PROFILE: PERSISTENT_DEFAULTS,
    SEASONAL_PROFILE: SEASONAL_DEFAULTS,
}


def parse_world_profile(value: str) -> str:
    profile = value.strip().lower()
    if profile not in WORLD_PROFILE_DEFAULTS:
        choices = ", ".join(VALID_WORLD_PROFILES)
        raise argparse.ArgumentTypeError(f"world profile must be one of: {choices}")
    return profile


def resolve_world_profile(
    value: str | None = None,
    environ: Mapping[str, str] | None = None,
) -> WorldProfileDefaults:
    env = environ if environ is not None else os.environ
    raw_value = value
    source = "--world-profile"
    if raw_value is None or not raw_value.strip():
        raw_value = env.get(WORLD_PROFILE_ENV, PERSISTENT_PROFILE)
        source = f"${WORLD_PROFILE_ENV}"
    if raw_value is None or not raw_value.strip():
        raw_value = PERSISTENT_PROFILE

    try:
        profile = parse_world_profile(raw_value)
    except argparse.ArgumentTypeError as exc:
        raise ValueError(f"invalid {source}: {exc}") from exc
    return WORLD_PROFILE_DEFAULTS[profile]


def add_world_profile_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--world-profile",
        default=None,
        type=parse_world_profile,
        help=(
            "World profile for default paths and selectors. "
            f"Default: ${WORLD_PROFILE_ENV} or {PERSISTENT_PROFILE}. "
            f"Choices: {', '.join(VALID_WORLD_PROFILES)}."
        ),
    )
