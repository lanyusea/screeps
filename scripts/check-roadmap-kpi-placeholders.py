#!/usr/bin/env python3
"""Regression checks for roadmap KPI placeholder chart shapes."""

from __future__ import annotations

import copy
import html
import importlib.util
import json
import re
import sys
from pathlib import Path
from types import ModuleType
from typing import Any, Sequence


JsonObject = dict[str, Any]
EXPECTED_KPI_TITLES = ("Territory", "Resources", "Combat")


def load_generator(repo_root: Path) -> ModuleType:
    generator_path = repo_root / "scripts" / "generate-roadmap-page.py"
    spec = importlib.util.spec_from_file_location("roadmap_page_generator", generator_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load generator from {generator_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def build_all_null_kpi_html(generator: ModuleType) -> tuple[str, list[JsonObject]]:
    dates = [str(value) for value in generator.KPI_DATES]
    cards: list[JsonObject] = []
    for source_card in generator.REPORT_KPI_CARDS:
        card = copy.deepcopy(source_card)
        card["dates"] = dates
        card["series"] = []
        for source_series in source_card.get("series", ()):
            series = dict(source_series)
            series["values"] = [None for _ in dates]
            series["statuses"] = ["missing" for _ in dates]
            card["series"].append(series)
        generator.normalize_report_chart_bounds(card)
        card["footer"] = generator.report_kpi_footer(card)
        cards.append(card)
    page_html = generator.strip_trailing_whitespace(generator.render_report_kpis({"report": {"kpiCards": cards}}))
    return page_html, cards


def extract_kpi_svgs(page_html: str) -> dict[str, str]:
    pattern = re.compile(r'<svg\b[^>]*aria-label="([^"]+) 7 day trend"[^>]*>(.*?)</svg>', re.DOTALL)
    return {html.unescape(title): body for title, body in pattern.findall(page_html)}


def find_tags(fragment: str, tag: str, required_text: str) -> list[str]:
    pattern = re.compile(rf"<{tag}\b[^>]*{re.escape(required_text)}[^>]*>", re.DOTALL)
    return pattern.findall(fragment)


def assert_check(failures: list[str], condition: bool, message: str) -> None:
    if not condition:
        failures.append(message)


def tag_has_attribute(tag: str, attribute: str) -> bool:
    return re.search(rf"(?:^|\s){re.escape(attribute)}(?:=|\s|/|>)", tag) is not None


def is_all_null_series(generator: ModuleType, series: JsonObject) -> bool:
    values = list(series.get("values", ()))
    return bool(values) and all(generator.chart_number(value) is None for value in values)


def validate_kpi_html(
    label: str,
    page_html: str,
    cards: Sequence[JsonObject],
    generator: ModuleType,
    failures: list[str],
) -> None:
    svgs = extract_kpi_svgs(page_html)
    titles = [str(card.get("title") or "") for card in cards]
    assert_check(
        failures,
        titles == list(EXPECTED_KPI_TITLES),
        f"{label}: KPI card titles should be {list(EXPECTED_KPI_TITLES)}, saw {titles}",
    )
    assert_check(failures, set(EXPECTED_KPI_TITLES).issubset(svgs.keys()), f"{label}: expected three KPI SVGs")

    for card in cards:
        title = str(card.get("title") or "")
        body = svgs.get(title, "")
        if not body:
            failures.append(f"{label}: missing SVG for {title}")
            continue

        grid_lines = find_tags(body, "line", 'stroke="#e4d7c8"')
        axis_lines = find_tags(body, "line", 'stroke="#cdbba7"')
        assert_check(failures, len(grid_lines) >= 3, f"{label}: {title} should render y-axis gridlines")
        assert_check(failures, len(axis_lines) >= 2, f"{label}: {title} should render x/y axes")

        dates = [str(value) for value in card.get("dates", generator.KPI_DATES)]
        for date_label in dates:
            assert_check(failures, f">{html.escape(date_label)}</text>" in body, f"{label}: {title} missing date label {date_label}")

        for series in card.get("series", ()):
            series_label = str(series.get("label") or "")
            assert_check(
                failures,
                f">{html.escape(series_label)}</text>" in body,
                f"{label}: {title} missing legend label {series_label}",
            )

        all_null_series = [series for series in card.get("series", ()) if is_all_null_series(generator, series)]
        if not all_null_series:
            continue

        placeholder_lines = find_tags(body, "polyline", 'data-kpi-placeholder="line"')
        placeholder_points = find_tags(body, "circle", 'data-kpi-placeholder="point"')
        expected_lines = len(all_null_series)
        expected_points = sum(len(list(series.get("values", ()))) for series in all_null_series)

        assert_check(
            failures,
            len(placeholder_lines) == expected_lines,
            f"{label}: {title} should render {expected_lines} placeholder lines, saw {len(placeholder_lines)}",
        )
        assert_check(
            failures,
            len(placeholder_points) == expected_points,
            f"{label}: {title} should render {expected_points} placeholder points, saw {len(placeholder_points)}",
        )
        for line in placeholder_lines:
            assert_check(failures, tag_has_attribute(line, "stroke-dasharray"), f"{label}: {title} placeholder line is not dashed")
            assert_check(failures, tag_has_attribute(line, "stroke-opacity"), f"{label}: {title} placeholder line is not muted")
        for point in placeholder_points:
            assert_check(failures, 'fill="none"' in point, f"{label}: {title} placeholder point is not hollow")
            assert_check(failures, tag_has_attribute(point, "stroke"), f"{label}: {title} placeholder point has no stroke")
            assert_check(failures, tag_has_attribute(point, "stroke-opacity"), f"{label}: {title} placeholder point is not muted")


def committed_page_inputs(repo_root: Path) -> tuple[str, list[JsonObject]] | None:
    html_path = repo_root / "docs" / "index.html"
    data_path = repo_root / "docs" / "roadmap-data.json"
    if not html_path.exists() or not data_path.exists():
        return None
    data = json.loads(data_path.read_text(encoding="utf-8"))
    cards = data.get("report", {}).get("kpiCards", [])
    if not isinstance(cards, list):
        raise RuntimeError("docs/roadmap-data.json report.kpiCards is not a list")
    return html_path.read_text(encoding="utf-8"), [card for card in cards if isinstance(card, dict)]


def main(argv: Sequence[str] | None = None) -> int:
    args = list(argv or sys.argv[1:])
    repo_root = Path(args[0]).resolve() if args else Path(__file__).resolve().parents[1]
    generator = load_generator(repo_root)
    failures: list[str] = []

    synthetic_html, synthetic_cards = build_all_null_kpi_html(generator)
    validate_kpi_html("synthetic all-null render", synthetic_html, synthetic_cards, generator, failures)

    committed_inputs = committed_page_inputs(repo_root)
    if committed_inputs is not None:
        committed_html, committed_cards = committed_inputs
        validate_kpi_html("docs/index.html", committed_html, committed_cards, generator, failures)

    if failures:
        print("Roadmap KPI placeholder check failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print("Roadmap KPI placeholder check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
