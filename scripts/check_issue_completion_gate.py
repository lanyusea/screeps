#!/usr/bin/env python3
"""Validate acceptance-first issue closure linkage in PR bodies."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


CLOSING_KEYWORD_RE = re.compile(
    r"\b(?:fix(?:es|ed)?|close(?:s|d)?|resolve(?:s|d)?)\b",
    re.IGNORECASE,
)
HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
ISSUE_REF_RE = re.compile(
    r"#(?P<hash>\d+)|https?://github\.com/[^\s/]+/[^\s/]+/issues/(?P<url>\d+)",
    re.IGNORECASE,
)
AMBIGUOUS_REF_RE = re.compile(
    r"(#\d+|https?://github\.com/[^\s/]+/[^\s/]+/issues/\d+|\bissue\s+\d+\b)",
    re.IGNORECASE,
)
NEGATED_CLOSE_RE = re.compile(
    r"\b(?:does\s+not|do\s+not|did\s+not|will\s+not|must\s+not|should\s+not|"
    r"cannot|can\s+not|can't|won't|not)\s+"
    r"(?:fix(?:es|ed)?|close(?:s|d)?|resolve(?:s|d)?)\b"
    r".{0,80}?"
    r"(#\d+|https?://github\.com/[^\s/]+/[^\s/]+/issues/\d+|\bissue\s+\d+\b)",
    re.IGNORECASE,
)
WITHOUT_CLOSE_RE = re.compile(
    r"\bwithout\s+(?:fixing|closing|resolving)\b"
    r".{0,80}?"
    r"(#\d+|https?://github\.com/[^\s/]+/[^\s/]+/issues/\d+|\bissue\s+\d+\b)",
    re.IGNORECASE,
)
GATE_HEADING_RE = re.compile(r"^(?P<level>#{1,6})\s+Issue closure gate\b", re.IGNORECASE)
ANY_HEADING_RE = re.compile(r"^(?P<level>#{1,6})\s+\S")
CHECKED_LINE_RE = re.compile(r"^\s*[-*]\s+\[[xX]\]\s+(?P<text>.+?)\s*$")
UNCHECKED_LINE_RE = re.compile(r"^\s*[-*]\s+\[\s\]\s+(?P<text>.+?)\s*$")
UNRESOLVED_EVIDENCE_RE = re.compile(
    r"\b(?:pending|blocked|blocker|successor|tbd|todo|remain(?:ing|s)?)\b|"
    r"\bowner\s+action\b|"
    r"\bpost[-\s]merge\b|"
    r"\bafter\s+merge\b|"
    r"\bfollow[-\s]up\b|"
    r"\bnot\s+verified\b|"
    r"\bnot\s+yet\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class IssueRef:
    number: int
    line: int
    keyword: str


@dataclass(frozen=True)
class GateLine:
    number: int
    text: str
    checked: bool


def issue_number_from_ref(ref: str) -> int | None:
    hash_match = re.search(r"#(\d+)", ref)
    if hash_match:
        return int(hash_match.group(1))
    url_match = re.search(r"/issues/(\d+)", ref, re.IGNORECASE)
    if url_match:
        return int(url_match.group(1))
    issue_match = re.search(r"\bissue\s+(\d+)\b", ref, re.IGNORECASE)
    if issue_match:
        return int(issue_match.group(1))
    return None


def extract_issue_refs(text: str) -> list[int]:
    refs: list[int] = []
    for match in ISSUE_REF_RE.finditer(text):
        raw = match.group("hash") or match.group("url")
        if raw is not None:
            refs.append(int(raw))
    return refs


def visible_markdown(body: str) -> str:
    return HTML_COMMENT_RE.sub(lambda match: "\n" * match.group(0).count("\n"), body)


def find_negated_phrases(body: str) -> list[str]:
    errors: list[str] = []
    for line_no, line in enumerate(body.splitlines(), start=1):
        for pattern in (NEGATED_CLOSE_RE, WITHOUT_CLOSE_RE):
            for match in pattern.finditer(line):
                ref_match = AMBIGUOUS_REF_RE.search(match.group(0))
                number = issue_number_from_ref(ref_match.group(0)) if ref_match else None
                target = f"issue {number}" if number is not None else "that issue"
                errors.append(
                    f"line {line_no}: ambiguous negated close-keyword phrase for {target}; "
                    f'use "Related to issue {number or "<number>"}" instead'
                )
    return errors


def find_closing_refs(body: str) -> list[IssueRef]:
    refs: list[IssueRef] = []
    for line_no, line in enumerate(body.splitlines(), start=1):
        for keyword_match in CLOSING_KEYWORD_RE.finditer(line):
            suffix = line[keyword_match.end() :]
            for number in extract_issue_refs(suffix):
                refs.append(IssueRef(number=number, line=line_no, keyword=keyword_match.group(0)))
    return refs


def extract_gate_section(body: str) -> list[tuple[int, str]] | None:
    lines = body.splitlines()
    start_index: int | None = None
    heading_level: int | None = None
    for index, line in enumerate(lines):
        match = GATE_HEADING_RE.match(line.strip())
        if match:
            start_index = index + 1
            heading_level = len(match.group("level"))
            break
    if start_index is None or heading_level is None:
        return None

    end_index = len(lines)
    for index in range(start_index, len(lines)):
        match = ANY_HEADING_RE.match(lines[index].strip())
        if match and len(match.group("level")) <= heading_level:
            end_index = index
            break
    return [(line_no, lines[line_no - 1]) for line_no in range(start_index + 1, end_index + 1)]


def parse_gate_lines(section: list[tuple[int, str]]) -> list[GateLine]:
    gate_lines: list[GateLine] = []
    for line_no, line in section:
        checked_match = CHECKED_LINE_RE.match(line)
        if checked_match:
            gate_lines.append(GateLine(number=line_no, text=checked_match.group("text"), checked=True))
            continue
        unchecked_match = UNCHECKED_LINE_RE.match(line)
        if unchecked_match:
            gate_lines.append(GateLine(number=line_no, text=unchecked_match.group("text"), checked=False))
    return gate_lines


def references_issue(text: str, issue_number: int) -> bool:
    return issue_number in extract_issue_refs(text)


def evidence_without_refs(text: str) -> str:
    return ISSUE_REF_RE.sub("", text).strip(" \t:-;,./")


def validate_body(body: str) -> list[str]:
    body = visible_markdown(body)
    negated_errors = find_negated_phrases(body)
    if negated_errors:
        return negated_errors

    closing_refs = find_closing_refs(body)
    if not closing_refs:
        return []

    closed_issues = sorted({ref.number for ref in closing_refs})
    section = extract_gate_section(body)
    if section is None:
        issue_list = ", ".join(f"#{number}" for number in closed_issues)
        return [f"missing Issue closure gate section for closing issue(s): {issue_list}"]

    gate_lines = parse_gate_lines(section)
    errors: list[str] = []
    for gate_line in gate_lines:
        if not gate_line.checked:
            errors.append(
                f"line {gate_line.number}: Issue closure gate contains unchecked checkbox line; "
                "use '- [x]' only after every closed issue is ready"
            )

    for issue_number in closed_issues:
        checked_lines = [
            gate_line
            for gate_line in gate_lines
            if gate_line.checked and references_issue(gate_line.text, issue_number)
        ]
        if not checked_lines:
            errors.append(
                f"Issue closure gate missing checked evidence line for #{issue_number}"
            )
            continue

        for gate_line in checked_lines:
            if not evidence_without_refs(gate_line.text):
                errors.append(
                    f"line {gate_line.number}: Issue closure gate evidence for #{issue_number} is empty"
                )
            if UNRESOLVED_EVIDENCE_RE.search(gate_line.text):
                errors.append(
                    f"line {gate_line.number}: Issue closure gate evidence for #{issue_number} "
                    "contains unresolved/blocking language"
                )
    return errors


def closed_issue_numbers(body: str) -> list[int]:
    body = visible_markdown(body)
    if find_negated_phrases(body):
        return []
    return sorted({ref.number for ref in find_closing_refs(body)})


def fetch_pr_body(pr_number: int, repo: str | None) -> str:
    cmd = ["gh", "pr", "view", str(pr_number), "--json", "body"]
    if repo:
        cmd.extend(["--repo", repo])
    completed = subprocess.run(
        cmd,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    payload = json.loads(completed.stdout)
    return payload.get("body") or ""


def read_body_file(path: str) -> str:
    if path == "-":
        return sys.stdin.read()
    return Path(path).read_text(encoding="utf-8")


SELF_TESTS: tuple[tuple[str, str, bool, str | None], ...] = (
    (
        "related_only",
        "## Linked issues\n\n- Related to issue 123\n",
        True,
        None,
    ),
    (
        "valid_close",
        "## Linked issues\n\n- Fixes #123\n\n"
        "## Issue closure gate\n\n"
        "- [x] #123: acceptance criteria satisfied by docs audit and self-test.\n"
        "- [x] No closed issue still needs post-merge validation, runtime/process proof, "
        "owner action, successor/follow-up work, partial-fix completion, or any other blocker.\n",
        True,
        None,
    ),
    (
        "valid_url_close",
        "Resolves https://github.com/lanyusea/screeps/issues/456\n\n"
        "## Issue closure gate\n\n"
        "- [x] #456: validator self-test covers the issue URL path.\n",
        True,
        None,
    ),
    (
        "valid_keyword_variants",
        "Fix #101\nClosed #102\nResolved #103\n\n"
        "## Issue closure gate\n\n"
        "- [x] #101: singular keyword variant is covered by self-test.\n"
        "- [x] #102: past close keyword variant is covered by self-test.\n"
        "- [x] #103: past resolve keyword variant is covered by self-test.\n",
        True,
        None,
    ),
    (
        "negated_close",
        "This documents policy and does not close #123.\n",
        False,
        "ambiguous negated close-keyword phrase",
    ),
    (
        "missing_gate",
        "Fixes #123\n",
        False,
        "missing Issue closure gate",
    ),
    (
        "unchecked_gate",
        "Fixes #123\n\n## Issue closure gate\n\n- [ ] #123: tests pass.\n",
        False,
        "unchecked",
    ),
    (
        "unchecked_generic_gate",
        "Fixes #123\n\n## Issue closure gate\n\n"
        "- [x] #123: acceptance verified by validator self-test.\n"
        "- [ ] No closed issue still needs post-merge validation, runtime/process proof, "
        "owner action, successor/follow-up work, partial-fix completion, or any other blocker.\n",
        False,
        "unchecked checkbox line",
    ),
    (
        "pending_evidence",
        "Fixes #123\n\n## Issue closure gate\n\n"
        "- [x] #123: implementation landed; post-merge validation pending.\n",
        False,
        "unresolved/blocking language",
    ),
    (
        "empty_evidence",
        "Fixes #123\n\n## Issue closure gate\n\n- [x] #123\n",
        False,
        "empty",
    ),
    (
        "multiple_refs_missing_one_gate_line",
        "Fixes #123 and closes #124\n\n## Issue closure gate\n\n"
        "- [x] #123: acceptance verified by self-test.\n",
        False,
        "missing checked evidence line for #124",
    ),
)


def run_self_tests() -> int:
    failures: list[str] = []
    for name, body, expect_pass, expected_message in SELF_TESTS:
        errors = validate_body(body)
        passed = not errors
        if passed != expect_pass:
            failures.append(f"{name}: expected pass={expect_pass}, got errors={errors!r}")
            continue
        if expected_message and not any(expected_message in error for error in errors):
            failures.append(f"{name}: expected error containing {expected_message!r}, got {errors!r}")
    if failures:
        print("FAIL: self-test")
        for failure in failures:
            print(f"- {failure}")
        return 1
    print(f"PASS: self-test ({len(SELF_TESTS)} fixture(s))")
    return 0


def print_validation_result(body: str, errors: list[str]) -> int:
    if errors:
        print("FAIL: issue completion gate")
        for error in errors:
            print(f"- {error}")
        return 1

    issues = closed_issue_numbers(body)
    if issues:
        issue_list = ", ".join(f"#{number}" for number in issues)
        print(f"PASS: issue completion gate ({len(issues)} closing issue(s): {issue_list})")
    else:
        print("PASS: issue completion gate (no closing keywords)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--body-file", help="path to a file containing the PR body, or '-' for stdin")
    source.add_argument("--pr", type=int, help="PR number to read with gh pr view")
    parser.add_argument("--repo", help="repository full name for gh pr view, for example owner/name")
    parser.add_argument("--self-test", action="store_true", help="run built-in validator fixtures")
    args = parser.parse_args()

    if not args.self_test and args.body_file is None and args.pr is None:
        parser.error("one of --self-test, --body-file, or --pr is required")

    exit_code = 0
    if args.self_test:
        exit_code = max(exit_code, run_self_tests())

    if args.body_file is not None:
        body = read_body_file(args.body_file)
        exit_code = max(exit_code, print_validation_result(body, validate_body(body)))
    elif args.pr is not None:
        try:
            body = fetch_pr_body(args.pr, args.repo)
        except (OSError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
            print(f"FAIL: unable to read PR body with gh pr view: {exc}")
            return 1
        exit_code = max(exit_code, print_validation_result(body, validate_body(body)))

    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
