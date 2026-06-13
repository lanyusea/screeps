#!/usr/bin/env python3
"""Validate Hermes cron output finalization before consuming it as evidence."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Sequence, TextIO


DEFAULT_MAX_BYTES = 256 * 1024

JOB_ID_RE = re.compile(r"^\*\*Job ID:\*\*\s*`?([A-Za-z0-9_-]+)`?\s*$", re.MULTILINE)
SECTION_RE_TEMPLATE = r"^\s*{heading}\s*$"
BROKEN_PIPE_ERRNO_RE = re.compile(r"(?:RuntimeError:\s*)?\[Errno 32\]\s+Broken pipe")
ISSUE_REF_RE = re.compile(
    r"(?<![\w/])#\d+\b|https://github\.com/[^\s)]+/[^\s)]+/(?:issues|pull)/\d+\b",
    re.IGNORECASE,
)
TABLE_SEPARATOR_CELL_RE = re.compile(r":?-{3,}:?")

GAMEPLAY_REQUIRED_SECTIONS: dict[str, tuple[str, ...]] = {
    "kpi_summary": ("## Vision KPI summary", "## KPI summary"),
    "practical_closed_loop_gate": ("## Practical gameplay closed-loop gate",),
    "rl_flywheel_product_review": ("## RL Flywheel Product Review",),
    "roadmap_targets": ("## Recommended roadmap changes",),
}


@dataclass(frozen=True)
class Diagnostic:
    path: str
    ok: bool
    classification: str
    route_issue: str
    reason: str
    job_id: str | None
    expected_job_id: str | None
    response_present: bool
    response_bytes: int
    error_present: bool
    broken_pipe: bool
    silent: bool
    missing_sections: list[str]
    github_targets: list[str]


def normalize_issue(value: str) -> str:
    stripped = value.strip()
    if stripped.startswith("#"):
        return stripped
    return f"#{stripped}"


def has_heading(text: str, heading: str) -> bool:
    pattern = SECTION_RE_TEMPLATE.format(heading=re.escape(heading))
    return re.search(pattern, text, re.MULTILINE) is not None


def markdown_heading_level(heading: str) -> int:
    stripped = heading.lstrip()
    return len(stripped) - len(stripped.lstrip("#"))


def extract_section_body(text: str, heading: str, *, stop_at_next_heading: bool = False) -> str | None:
    matches = re.finditer(SECTION_RE_TEMPLATE.format(heading=re.escape(heading)), text, re.MULTILINE)
    last_match = None
    for match in matches:
        last_match = match
    if last_match is None:
        return None
    body = text[last_match.end() :]
    if stop_at_next_heading:
        level = markdown_heading_level(heading)
        if level > 0:
            next_heading = re.search(rf"^\s*#{{1,{level}}}\s+\S", body, re.MULTILINE)
            if next_heading:
                body = body[: next_heading.start()]
    return body.strip()


def last_heading_start(text: str, heading: str) -> int | None:
    last_start = None
    for match in re.finditer(SECTION_RE_TEMPLATE.format(heading=re.escape(heading)), text, re.MULTILINE):
        last_start = match.start()
    return last_start


def has_broken_pipe_transport_failure(text: str, response: str | None, error_body: str | None) -> bool:
    response_start = last_heading_start(text, "## Response")
    error_start = last_heading_start(text, "## Error")

    if error_start is not None and (response_start is None or error_start > response_start):
        return error_body is not None and BROKEN_PIPE_ERRNO_RE.search(error_body) is not None
    if response_start is not None:
        return response is not None and BROKEN_PIPE_ERRNO_RE.search(response) is not None
    return BROKEN_PIPE_ERRNO_RE.search(text) is not None


def extract_job_id(text: str) -> str | None:
    match = JOB_ID_RE.search(text)
    return match.group(1) if match else None


def extract_github_targets(text: str) -> list[str]:
    return sorted(set(match.group(0) for match in ISSUE_REF_RE.finditer(text)))


def extract_gameplay_roadmap_body(response: str) -> str | None:
    for heading in GAMEPLAY_REQUIRED_SECTIONS["roadmap_targets"]:
        body = extract_section_body(response, heading, stop_at_next_heading=True)
        if body is not None:
            return body
    return None


def split_markdown_table_row(line: str) -> list[str] | None:
    stripped = line.strip()
    if not stripped.startswith("|") or "|" not in stripped[1:]:
        return None
    return [cell.strip() for cell in stripped.strip("|").split("|")]


def is_markdown_table_separator(cells: list[str]) -> bool:
    return bool(cells) and all(TABLE_SEPARATOR_CELL_RE.fullmatch(cell.replace(" ", "")) for cell in cells)


def roadmap_table_targets(roadmap_body: str) -> tuple[bool, list[str]]:
    target_indexes: list[int] = []
    targets: set[str] = set()
    for line in roadmap_body.splitlines():
        cells = split_markdown_table_row(line)
        if cells is None:
            continue
        if not target_indexes:
            target_indexes = [index for index, cell in enumerate(cells) if cell.lower() == "github target"]
            continue
        if is_markdown_table_separator(cells):
            continue
        for index in target_indexes:
            if index < len(cells):
                targets.update(extract_github_targets(cells[index]))
    return bool(target_indexes), sorted(targets)


def extract_gameplay_github_targets(response: str) -> list[str]:
    roadmap_body = extract_gameplay_roadmap_body(response)
    if roadmap_body is None:
        return []
    _, targets = roadmap_table_targets(roadmap_body)
    return targets


def missing_gameplay_sections(response: str) -> list[str]:
    missing: list[str] = []
    for key, alternatives in GAMEPLAY_REQUIRED_SECTIONS.items():
        if key == "roadmap_targets":
            continue
        if not any(has_heading(response, heading) for heading in alternatives):
            missing.append(key)

    roadmap_body = extract_gameplay_roadmap_body(response)
    if roadmap_body is None:
        missing.append("roadmap_targets")
        roadmap_body = ""
    has_target_column, targets = roadmap_table_targets(roadmap_body)
    if not has_target_column:
        missing.append("github_target_column")
    if not targets:
        missing.append("github_target_refs")
    return missing


def diagnose_text(
    text: str,
    *,
    path: str,
    mode: str,
    route_issue: str,
    expected_job_id: str | None,
) -> Diagnostic:
    response = extract_section_body(text, "## Response")
    error_body = extract_section_body(text, "## Error")
    response_present = response is not None
    error_present = error_body is not None
    response_bytes = 0 if response is None else len(response.encode("utf-8"))
    broken_pipe = has_broken_pipe_transport_failure(text, response, error_body)

    job_id = extract_job_id(text)
    if expected_job_id and job_id is None:
        return Diagnostic(
            path=path,
            ok=False,
            classification="missing_job_id",
            route_issue=route_issue,
            reason=f"artifact has no Job ID; expected {expected_job_id}",
            job_id=None,
            expected_job_id=expected_job_id,
            response_present=response_present,
            response_bytes=response_bytes,
            error_present=error_present,
            broken_pipe=broken_pipe,
            silent=False,
            missing_sections=[],
            github_targets=[],
        )

    if expected_job_id and job_id and job_id != expected_job_id:
        return Diagnostic(
            path=path,
            ok=False,
            classification="job_id_mismatch",
            route_issue=route_issue,
            reason=f"artifact job id {job_id} does not match expected {expected_job_id}",
            job_id=job_id,
            expected_job_id=expected_job_id,
            response_present=response_present,
            response_bytes=response_bytes,
            error_present=error_present,
            broken_pipe=broken_pipe,
            silent=False,
            missing_sections=[],
            github_targets=[],
        )

    if broken_pipe:
        return Diagnostic(
            path=path,
            ok=False,
            classification="outer_cron_finalization",
            route_issue=route_issue,
            reason="Broken pipe occurred in the cron final-output transport; do not consume as gameplay evidence.",
            job_id=job_id,
            expected_job_id=expected_job_id,
            response_present=response_present,
            response_bytes=response_bytes,
            error_present=error_present,
            broken_pipe=True,
            silent=False,
            missing_sections=[],
            github_targets=[],
        )

    if response is None:
        return Diagnostic(
            path=path,
            ok=False,
            classification="missing_response",
            route_issue=route_issue,
            reason="cron artifact has no final ## Response section.",
            job_id=job_id,
            expected_job_id=expected_job_id,
            response_present=False,
            response_bytes=0,
            error_present=error_present,
            broken_pipe=False,
            silent=False,
            missing_sections=[],
            github_targets=[],
        )

    if response == "[SILENT]":
        return Diagnostic(
            path=path,
            ok=True,
            classification="silent",
            route_issue=route_issue,
            reason="cron response is exactly [SILENT].",
            job_id=job_id,
            expected_job_id=expected_job_id,
            response_present=True,
            response_bytes=response_bytes,
            error_present=error_present,
            broken_pipe=False,
            silent=True,
            missing_sections=[],
            github_targets=[],
        )

    if mode == "gameplay-review":
        missing_sections = missing_gameplay_sections(response)
        github_targets = extract_gameplay_github_targets(response)
    else:
        missing_sections = []
        github_targets = extract_github_targets(response)
    if missing_sections:
        return Diagnostic(
            path=path,
            ok=False,
            classification="invalid_gameplay_review_output",
            route_issue=route_issue,
            reason="Gameplay Evolution response is missing the compact final-output contract.",
            job_id=job_id,
            expected_job_id=expected_job_id,
            response_present=True,
            response_bytes=response_bytes,
            error_present=error_present,
            broken_pipe=False,
            silent=False,
            missing_sections=missing_sections,
            github_targets=github_targets,
        )

    return Diagnostic(
        path=path,
        ok=True,
        classification="response_ok",
        route_issue=route_issue,
        reason="cron artifact has a final response that satisfies the selected contract.",
        job_id=job_id,
        expected_job_id=expected_job_id,
        response_present=True,
        response_bytes=response_bytes,
        error_present=error_present,
        broken_pipe=False,
        silent=False,
        missing_sections=[],
        github_targets=github_targets,
    )


def read_bounded(path: Path, *, max_bytes: int) -> str:
    size = path.stat().st_size
    if size > max_bytes:
        raise ValueError(f"{path} is {size} bytes, exceeding --max-bytes={max_bytes}")
    return path.read_text(encoding="utf-8")


def render_text(diagnostic: Diagnostic) -> str:
    status = "PASS" if diagnostic.ok else "FAIL"
    lines = [
        f"{status}: cron output finalization diagnostic",
        f"path={diagnostic.path}",
        f"classification={diagnostic.classification}",
        f"route_issue={diagnostic.route_issue}",
        f"reason={diagnostic.reason}",
    ]
    if diagnostic.job_id:
        lines.append(f"job_id={diagnostic.job_id}")
    if diagnostic.github_targets:
        lines.append(f"github_targets={', '.join(diagnostic.github_targets)}")
    if diagnostic.missing_sections:
        lines.append(f"missing_sections={', '.join(diagnostic.missing_sections)}")
    lines.append(f"response_bytes={diagnostic.response_bytes}")
    return "\n".join(lines) + "\n"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Check a Hermes cron markdown output for a finalized ## Response, exact [SILENT], "
            "or a bounded final-output transport failure that must route to an Agent OS issue."
        )
    )
    parser.add_argument("artifact", type=Path, help="cron output markdown artifact to validate")
    parser.add_argument(
        "--mode",
        choices=("generic", "gameplay-review"),
        default="generic",
        help="output contract to enforce after finalization succeeds",
    )
    parser.add_argument("--job-id", help="expected cron job id")
    parser.add_argument(
        "--agent-os-issue",
        default="1860",
        help="exact Agent OS issue number or #ref that should own final-output failures",
    )
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=DEFAULT_MAX_BYTES,
        help="maximum artifact size to read; oversized files fail closed",
    )
    parser.add_argument("--format", choices=("text", "json"), default="text")
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    args = build_parser().parse_args(argv)
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr
    route_issue = normalize_issue(args.agent_os_issue)

    try:
        text = read_bounded(args.artifact, max_bytes=args.max_bytes)
    except (OSError, ValueError) as exc:
        diagnostic = Diagnostic(
            path=str(args.artifact),
            ok=False,
            classification="artifact_unreadable_or_oversized",
            route_issue=route_issue,
            reason=str(exc),
            job_id=None,
            expected_job_id=args.job_id,
            response_present=False,
            response_bytes=0,
            error_present=False,
            broken_pipe=False,
            silent=False,
            missing_sections=[],
            github_targets=[],
        )
        output = json.dumps(asdict(diagnostic), sort_keys=True) + "\n" if args.format == "json" else render_text(diagnostic)
        stderr.write(output)
        return 1

    diagnostic = diagnose_text(
        text,
        path=str(args.artifact),
        mode=args.mode,
        route_issue=route_issue,
        expected_job_id=args.job_id,
    )
    output = json.dumps(asdict(diagnostic), sort_keys=True) + "\n" if args.format == "json" else render_text(diagnostic)
    (stdout if diagnostic.ok else stderr).write(output)
    return 0 if diagnostic.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
