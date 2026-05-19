#!/usr/bin/env python3
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import screeps_rl_scale_gates as gates


class RlScaleGatesTest(unittest.TestCase):
    def test_classifies_threshold_boundaries(self) -> None:
        cases = (
            ("env-row-smoke", 49, 1_600_000, "smoke"),
            ("tick-smoke", 800, 49_999, "smoke"),
            ("minimum-intermediate", 50, 50_000, "intermediate"),
            ("env-row-below-validation", 199, 1_600_000, "intermediate"),
            ("tick-below-validation", 800, 199_999, "intermediate"),
            ("validation-floor", 200, 200_000, "validation"),
            ("env-row-below-normal", 399, 400_000, "validation"),
            ("tick-below-normal", 400, 399_999, "validation"),
            ("normal-scale-floor", 400, 400_000, "normal-scale"),
            ("env-row-below-large", 799, 1_600_000, "normal-scale"),
            ("tick-below-large", 800, 1_599_999, "normal-scale"),
            ("large-campaign-floor", 800, 1_600_000, "large-campaign"),
        )
        for name, rows, ticks, expected in cases:
            with self.subTest(name=name):
                self.assertEqual(gates.classify_batch_scale(rows, ticks), expected)

    def test_only_validation_and_larger_batches_are_scale_first_eligible(self) -> None:
        self.assertFalse(gates.scale_first_eligible("smoke"))
        self.assertFalse(gates.scale_first_eligible("intermediate"))
        self.assertTrue(gates.scale_first_eligible("validation"))
        self.assertTrue(gates.scale_first_eligible("normal-scale"))
        self.assertTrue(gates.scale_first_eligible("large-campaign"))

    def test_summary_includes_utilization_when_wall_and_asg_time_are_available(self) -> None:
        summary = gates.build_batch_scale_summary(
            environment_rows=200,
            simulator_ticks=200_000,
            wall_clock_seconds=120,
            asg_active_seconds=600,
            cost_estimate={"currency": "USD", "amount": 0.25},
        )

        self.assertEqual(summary["batchClass"], "validation")
        self.assertTrue(summary["scaleFirstEligible"])
        self.assertEqual(summary["utilizationRatio"], 0.2)
        self.assertEqual(summary["costEstimate"], {"currency": "USD", "amount": 0.25})


if __name__ == "__main__":
    unittest.main()
