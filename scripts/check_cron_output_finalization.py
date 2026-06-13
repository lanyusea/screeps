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
BROKEN_PIPE_RE = re.compile(r"(?:RuntimeError:\s*)?\[Errno 32\]\s+Broken pipe|\bBroken pipe\b")
ISSUE_REF_RE = re.compile(
    r"(?<![\w/])#\d+\b|https://github\.com/[^\s)]+/[^\s)]+/(?:issues|pull)/\d+\b",
    re.IGNORECASE,
)

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


def extract_section_body(text: str, heading: str) -> str | None:
    match = re.search(SECTION_RE_TEMPLATE.format(heading=re.escape(heading)), text, re.MULTILINE)
    if not match:
        return None
    return text[match.end() :].strip()


def extract_job_id(text: str) -> str | None:
    match = JOB_ID_RE.search(text)
    return match.group(1) if match else None


def extract_github_targets(text: str) -> list[str]:
    return sorted(set(match.group(0) for match in ISSUE_REF_RE.finditer(text)))


def missing_gameplay_sections(response: str) -> list[str]:
    missing: list[str] = []
    for key, alternatives in GAMEPLAY_REQUIRED_SECTIONS.items():
        if not any(has_heading(response, heading) for heading in alternatives):
            missing.append(key)
    if "GitHub target" not in response:
        missing.append("github_target_column")
    if not extract_github_targets(response):
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
    broken_pipe = bool(BROKEN_PIPE_RE.search(error_body or ""))
    if not broken_pipe and not response_present:
        broken_pipe = bool(BROKEN_PIPE_RE.search(text))

    job_id = extract_job_id(text)
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
            response_bytes=0 if response is None else len(response.encode("utf-8")),
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
            response_bytes=0 if response is None else len(response.encode("utf-8")),
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

    response_bytes = len(response.encode("utf-8"))
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

    missing_sections = missing_gameplay_sections(response) if mode == "gameplay-review" else []
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
    return path.read_text(encoding="utf-8", errors="replace")


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
