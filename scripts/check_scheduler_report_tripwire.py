#!/usr/bin/env python3
"""Fail scheduler reports that leave P0/P1 action items as untracked prose."""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence, TextIO


PRIORITY_RE = re.compile(r"\bP([01])\b|\bpriority:p([01])\b", re.IGNORECASE)
ANY_PRIORITY_RE = re.compile(r"\bP([0-3])\b|\bpriority:p([0-3])\b", re.IGNORECASE)
ISSUE_REF_RE = re.compile(
    r"(?<![\w/])#\d+\b|https://github\.com/[^\s)]+/[^\s)]+/(?:issues|pull)/\d+\b",
    re.IGNORECASE,
)
HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.+?)\s*$")
LIST_ITEM_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
NEGATIVE_STATUS_RE = re.compile(
    r"(?:\b(?:no|none|zero)\b.{0,80}\b(?:P0|P1|priority:p[01])\b.{0,80}\b"
    r"(?:action|follow[- ]?up|gap|defect|blocker|untracked|prose[- ]?only)|"
    r"\b(?:P0|P1|priority:p[01])\b.{0,80}\b(?:no|none|zero)\b.{0,80}\b"
    r"(?:action|follow[- ]?up|gap|defect|blocker|untracked|prose[- ]?only))",
    re.IGNORECASE,
)
ACTION_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"\baction[- ]?items?\b",
        r"\bfollow[- ]?ups?\b",
        r"\bnext actions?\b",
        r"\bTODO\b",
        r"\bfix(?:es|ed)?\b",
        r"\brepair(?:s|ed)?\b",
        r"\bmitigat(?:e|es|ed|ion)\b",
        r"\bresolv(?:e|es|ed)\b",
        r"\bblock(?:er|ers|ed|ing)?\b",
        r"\bgaps?\b",
        r"\bdefects?\b",
        r"\bregressions?\b",
        r"\buntracked\b",
        r"\bprose[- ]?only\b",
        r"\bmissing (?:issue|project|github|tracking|work item)\b",
        r"\bneeds? (?:issue|project|github|tracking|fix|repair|work|follow[- ]?up|"
        r"owner[- ]?decision|implementation|codex|qa)\b",
        r"\b(?:create|open|file|update|refresh|track) (?:a |an |the |this )?"
        r"(?:github )?(?:issue|project item|work item|task|follow[- ]?up)\b",
    )
)


@dataclass(frozen=True)
class Block:
    path: str
    line: int
    text: str
    kind: str
    context_priority: str | None


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    priority: str
    phrase: str
    text: str


def priority_label(text: str) -> str | None:
    match = PRIORITY_RE.search(text)
    if not match:
        return None
    value = match.group(1) or match.group(2)
    return f"P{value}"


def priority_context_from_heading(
    text: str,
    *,
    level: int,
    previous: str | None,
    previous_level: int | None,
) -> tuple[str | None, int | None]:
    priority = priority_label(text)
    if priority:
        return priority, level
    if ANY_PRIORITY_RE.search(text):
        return None, None
    if previous is not None and previous_level is not None and level <= previous_level:
        return None, None
    return previous, previous_level


def action_phrase(text: str) -> str | None:
    for pattern in ACTION_PATTERNS:
        match = pattern.search(text)
        if match:
            return match.group(0)
    return None


def compact(text: str, *, limit: int = 180) -> str:
    rendered = " ".join(text.split())
    if len(rendered) <= limit:
        return rendered
    return rendered[: limit - 3].rstrip() + "..."


def iter_blocks(path: str, text: str) -> list[Block]:
    blocks: list[Block] = []
    pending_lines: list[str] = []
    pending_start = 1
    pending_kind = "paragraph"
    active_priority: str | None = None
    active_priority_level: int | None = None

    def flush() -> None:
        nonlocal pending_lines, pending_start, pending_kind
        if not pending_lines:
            return
        blocks.append(
            Block(
                path=path,
                line=pending_start,
                text="\n".join(pending_lines),
                kind=pending_kind,
                context_priority=active_priority,
            )
        )
        pending_lines = []

    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        stripped = raw_line.strip()
        if not stripped:
            flush()
            continue

        heading = HEADING_RE.match(raw_line)
        starts_list_item = LIST_ITEM_RE.match(raw_line) is not None
        starts_new_block = bool(heading or starts_list_item)
        if starts_new_block:
            flush()
            pending_start = line_number
            pending_kind = "heading" if heading else "list-item"
            pending_lines = [raw_line]
            if heading:
                active_priority, active_priority_level = priority_context_from_heading(
                    heading.group(2),
                    level=len(heading.group(1)),
                    previous=active_priority,
                    previous_level=active_priority_level,
                )
                flush()
            continue

        if not pending_lines:
            pending_start = line_number
            pending_kind = "paragraph"
        pending_lines.append(raw_line)

    flush()
    return blocks


def find_untracked_action_items(path: str, text: str) -> list[Finding]:
    findings: list[Finding] = []
    for block in iter_blocks(path, text):
        if block.kind == "heading" or NEGATIVE_STATUS_RE.search(block.text):
            continue
        priority = priority_label(block.text) or block.context_priority
        if priority is None:
            continue
        phrase = action_phrase(block.text)
        if phrase is None or ISSUE_REF_RE.search(block.text):
            continue
        findings.append(
            Finding(
                path=block.path,
                line=block.line,
                priority=priority,
                phrase=phrase,
                text=compact(block.text),
            )
        )
    return findings


def read_report(path: str, stdin: TextIO) -> str:
    if path == "-":
        return stdin.read()
    return Path(path).read_text(encoding="utf-8", errors="replace")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Scan scheduler/report text for P0/P1 action-item prose that is not tied "
            "to a GitHub issue or pull request reference."
        )
    )
    parser.add_argument(
        "reports",
        nargs="*",
        default=["-"],
        help="report text files to scan, or '-' for stdin (default: stdin)",
    )
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    args = build_parser().parse_args(argv)
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr

    findings: list[Finding] = []
    for report in args.reports:
        try:
            findings.extend(find_untracked_action_items(report, read_report(report, stdin)))
        except OSError as exc:
            print(f"ERROR: failed to read {report}: {exc}", file=stderr)
            return 2

    if findings:
        print("FAIL: scheduler report contains untracked P0/P1 action-item prose", file=stderr)
        for finding in findings:
            print(
                f"ERROR: {finding.path}:{finding.line}: {finding.priority} '{finding.phrase}' "
                f"needs a same-item GitHub issue or pull request reference: {finding.text}",
                file=stderr,
            )
        print(
            "Create/update the GitHub issue and Project item first, then link the item with "
            "#<issue>, a GitHub issue URL, or a GitHub pull request URL before reporting completion.",
            file=stderr,
        )
        return 1

    print(f"PASS: scheduler report tripwire ({len(args.reports)} input(s))", file=stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
