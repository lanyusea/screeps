#!/usr/bin/env python3
"""Compatibility entrypoint for the runtime KPI reducer."""

from __future__ import annotations

from screeps_runtime_kpi_reducer import *  # noqa: F403 - preserve legacy script/module surface
from screeps_runtime_kpi_reducer import main


if __name__ == "__main__":
    raise SystemExit(main())
