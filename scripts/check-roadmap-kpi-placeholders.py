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
        placeholder_lines = find_tags(body, "polyline", 'data-kpi-placeholder="line"')
        placeholder_points = find_tags(body, "circle", 'data-kpi-placeholder="point"')
        assert_check(failures, not placeholder_lines, f"{label}: {title} must not render fake placeholder KPI lines")
        assert_check(failures, not placeholder_points, f"{label}: {title} must not render fake placeholder KPI points")
        if not all_null_series:
            continue

        assert_check(
            failures,
            'data-kpi-unavailable="true"' in body,
            f"{label}: {title} all-null KPI chart should explicitly mark data as unavailable",
        )
        assert_check(
            failures,
            "No observed KPI data" in html.unescape(body),
            f"{label}: {title} all-null KPI chart should say no observed KPI data",
        )


def committed_page_inputs(repo_root: Path) -> tuple[str, list[JsonObject], JsonObject] | None:
    html_path = repo_root / "docs" / "index.html"
    data_path = repo_root / "docs" / "roadmap-data.json"
    if not html_path.exists() or not data_path.exists():
        return None
    data = json.loads(data_path.read_text(encoding="utf-8"))
    cards = data.get("report", {}).get("kpiCards", [])
    if not isinstance(cards, list):
        raise RuntimeError("docs/roadmap-data.json report.kpiCards is not a list")
    return html_path.read_text(encoding="utf-8"), [card for card in cards if isinstance(card, dict)], data


def deploy_evidence_count(data: JsonObject) -> int:
    github = data.get("github", {})
    if not isinstance(github, dict):
        return 0
    evidence: set[str] = set()
    for collection_name in ("issues", "projectItems"):
        collection = github.get(collection_name)
        if not isinstance(collection, list):
            continue
        for item in collection:
            if not isinstance(item, dict):
                continue
            text = " ".join(str(item.get(key) or "") for key in ("title", "status", "evidence", "nextAction")).lower()
            run_ids = re.findall(r"official deploy run\s+(\d+)", text)
            for run_id in run_ids:
                evidence.add(f"run:{run_id}")
            if not run_ids and "deployment floor satisfied" in text and "official deploy" in text:
                evidence.add(f"item:{item.get('number', len(evidence))}")
    return len(evidence)


def process_card_value(data: JsonObject, label: str) -> Any:
    cards = data.get("report", {}).get("processCards", [])
    if not isinstance(cards, list):
        return None
    for card in cards:
        if isinstance(card, dict) and card.get("label") == label:
            return card.get("value")
    return None


def validate_process_metrics(data: JsonObject, failures: list[str]) -> None:
    evidence_count = deploy_evidence_count(data)
    official_deploys = process_card_value(data, "Official deploys")
    if evidence_count:
        assert_check(
            failures,
            isinstance(official_deploys, int) and official_deploys >= evidence_count,
            "docs/roadmap-data.json: Official deploys must reflect observed official deploy evidence instead of reporting 0",
        )


def main(argv: Sequence[str] | None = None) -> int:
    args = list(argv or sys.argv[1:])
    repo_root = Path(args[0]).resolve() if args else Path(__file__).resolve().parents[1]
    generator = load_generator(repo_root)
    failures: list[str] = []

    synthetic_html, synthetic_cards = build_all_null_kpi_html(generator)
    validate_kpi_html("synthetic all-null render", synthetic_html, synthetic_cards, generator, failures)

    committed_inputs = committed_page_inputs(repo_root)
    if committed_inputs is not None:
        committed_html, committed_cards, committed_data = committed_inputs
        validate_kpi_html("docs/index.html", committed_html, committed_cards, generator, failures)
        validate_process_metrics(committed_data, failures)

    if failures:
        print("Roadmap KPI placeholder check failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print("Roadmap KPI placeholder check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
