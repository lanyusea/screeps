#!/usr/bin/env python3
"""Validate acceptance-first issue closure linkage in PR bodies and commits."""
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
UNIVERSAL_DONE_GATE_HEADING_RE = re.compile(
    r"^(?P<level>#{1,6})\s+Universal task Done gate\b",
    re.IGNORECASE,
)
ANY_HEADING_RE = re.compile(r"^(?P<level>#{1,6})\s+\S")
CHECKED_LINE_RE = re.compile(r"^\s*[-*]\s+\[[xX]\]\s+(?P<text>.+?)\s*$")
UNCHECKED_LINE_RE = re.compile(r"^\s*[-*]\s+\[\s\]\s+(?P<text>.+?)\s*$")
UNRESOLVED_EVIDENCE_RE = re.compile(
    r"\b(?:pending|blocked|tbd|todo)\b|"
    r"\bremaining\s+"
    r"(?:blockers?|work|validation|owner[-\s]action|follow[-\s]?ups?|successors?|"
    r"post[-\s]merge(?:\s+validation)?)\b|"
    r"\bafter\s+merge\b|"
    r"\bnot\s+verified\b|"
    r"\bnot\s+yet\b",
    re.IGNORECASE,
)
NOT_APPLICABLE_RE = re.compile(r"\b(?:n/a|not applicable|none)\b", re.IGNORECASE)
OWNER_ACCEPTED_SUBSTITUTE_RE = re.compile(
    r"\bowner[-\s](?:accepted|approved)\s+substitute\b",
    re.IGNORECASE,
)
NAMED_SURFACE_RE = re.compile(
    r"\b(?:Grafana|GitHub Pages|Discord route|deployed service|public URL|"
    r"specific monitor|dashboard|report|service|route|URL)\b",
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


@dataclass(frozen=True)
class DoneGateField:
    name: str
    pattern: re.Pattern[str]


@dataclass(frozen=True)
class PullRequestCommit:
    sha: str
    message: str


UNIVERSAL_DONE_GATE_FIELDS: tuple[DoneGateField, ...] = (
    DoneGateField("Task type", re.compile(r"^Task type\s*:", re.IGNORECASE)),
    DoneGateField(
        "Expected observable outcome / named deliverable",
        re.compile(
            r"^Expected observable outcome\s*/\s*named deliverable\s*:",
            re.IGNORECASE,
        ),
    ),
    DoneGateField(
        "Non-goals / accepted substitutes",
        re.compile(r"^Non-goals\s*/\s*accepted substitutes\s*:", re.IGNORECASE),
    ),
    DoneGateField(
        "Verification evidence required before Done",
        re.compile(r"^Verification evidence required before Done\s*:", re.IGNORECASE),
    ),
    DoneGateField(
        "Project Evidence / Next action / Blocked by",
        re.compile(r"^Project Evidence\s*/\s*Next action\s*/\s*Blocked by\s*:", re.IGNORECASE),
    ),
    DoneGateField(
        "Post-merge/deploy/runtime proof",
        re.compile(r"^Post-merge/deploy/runtime proof\s*:", re.IGNORECASE),
    ),
    DoneGateField(
        "Named deliverable proof",
        re.compile(r"^Named deliverable proof\s*:", re.IGNORECASE),
    ),
)


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


def extract_heading_section(body: str, heading_re: re.Pattern[str]) -> list[tuple[int, str]] | None:
    lines = body.splitlines()
    start_index: int | None = None
    heading_level: int | None = None
    for index, line in enumerate(lines):
        match = heading_re.match(line.strip())
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


def extract_gate_section(body: str) -> list[tuple[int, str]] | None:
    return extract_heading_section(body, GATE_HEADING_RE)


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


def evidence_after_colon(text: str) -> str:
    _, separator, evidence = text.partition(":")
    if not separator:
        return ""
    return evidence.strip(" \t:-;,./")


def has_unresolved_done_gate_language(evidence: str) -> bool:
    searchable = re.sub(r"\bBlocked by\b", "", evidence, flags=re.IGNORECASE)
    return bool(UNRESOLVED_EVIDENCE_RE.search(searchable))


def checked_done_gate_field_lines(gate_lines: list[GateLine], field: DoneGateField) -> list[GateLine]:
    return [
        gate_line
        for gate_line in gate_lines
        if gate_line.checked and field.pattern.search(gate_line.text)
    ]


def validate_universal_done_gate(body: str, *, require: bool) -> list[str]:
    section = extract_heading_section(body, UNIVERSAL_DONE_GATE_HEADING_RE)
    if section is None:
        if require:
            return [
                "missing Universal task Done gate section with task type, named deliverable, "
                "verification, Project state, and post-merge proof evidence"
            ]
        return []

    gate_lines = parse_gate_lines(section)
    errors: list[str] = []
    for gate_line in gate_lines:
        if not gate_line.checked:
            errors.append(
                f"line {gate_line.number}: Universal task Done gate contains unchecked checkbox line; "
                "use '- [x]' only after the task contract is ready for Done"
            )

    field_values: dict[str, list[str]] = {}
    for field in UNIVERSAL_DONE_GATE_FIELDS:
        field_lines = checked_done_gate_field_lines(gate_lines, field)
        if not field_lines:
            errors.append(f"Universal task Done gate missing checked field: {field.name}")
            continue
        values: list[str] = []
        for gate_line in field_lines:
            evidence = evidence_after_colon(gate_line.text)
            values.append(evidence)
            if not evidence:
                errors.append(
                    f"line {gate_line.number}: Universal task Done gate field {field.name!r} "
                    "has empty evidence"
                )
            if has_unresolved_done_gate_language(evidence):
                errors.append(
                    f"line {gate_line.number}: Universal task Done gate field {field.name!r} "
                    "contains unresolved/blocking language"
                )
        field_values[field.name] = values

    expected_values = field_values.get("Expected observable outcome / named deliverable", [])
    named_proof_values = field_values.get("Named deliverable proof", [])
    expected_text = " ".join(expected_values)
    named_proof_text = " ".join(named_proof_values)
    if NAMED_SURFACE_RE.search(expected_text):
        proof_is_absent = NOT_APPLICABLE_RE.search(named_proof_text)
        proof_has_substitute = OWNER_ACCEPTED_SUBSTITUTE_RE.search(named_proof_text)
        if proof_is_absent and not proof_has_substitute:
            errors.append(
                "Universal task Done gate names a deliverable surface but the Named deliverable proof "
                "field says it is not applicable; prove that named surface or cite an owner-accepted substitute"
            )
    return errors


def format_issue_list(issue_numbers: list[int]) -> str:
    return ", ".join(f"#{number}" for number in issue_numbers)


def validate_body(body: str, *, require_universal_done_gate: bool = False) -> list[str]:
    body = visible_markdown(body)
    negated_errors = find_negated_phrases(body)
    if negated_errors:
        return negated_errors

    universal_done_gate_errors = validate_universal_done_gate(
        body,
        require=require_universal_done_gate,
    )

    closing_refs = find_closing_refs(body)
    if not closing_refs:
        return universal_done_gate_errors

    closed_issues = sorted({ref.number for ref in closing_refs})
    section = extract_gate_section(body)
    if section is None:
        issue_list = ", ".join(f"#{number}" for number in closed_issues)
        return [
            *universal_done_gate_errors,
            f"missing Issue closure gate section for closing issue(s): {issue_list}",
        ]

    gate_lines = parse_gate_lines(section)
    errors: list[str] = [*universal_done_gate_errors]
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


def short_sha(sha: str) -> str:
    return sha[:7] if sha else "<unknown>"


def validate_commit_messages(commits: list[PullRequestCommit]) -> list[str]:
    errors: list[str] = []
    for commit in commits:
        negated_errors = find_negated_phrases(commit.message)
        if negated_errors:
            for error in negated_errors:
                errors.append(
                    f"commit {short_sha(commit.sha)}: {error}; "
                    "commit messages cannot carry PR Issue closure gate evidence"
                )
            continue

        closing_refs = find_closing_refs(commit.message)
        if not closing_refs:
            continue

        issue_list = format_issue_list(sorted({ref.number for ref in closing_refs}))
        errors.append(
            f"commit {short_sha(commit.sha)}: commit message contains GitHub closing keyword "
            f"for {issue_list}; commit messages cannot carry PR Issue closure gate evidence, "
            "so move intentional closure to the PR body Issue closure gate or use non-closing wording"
        )
    return errors


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


def resolve_repo(repo: str | None) -> str:
    if repo:
        return repo
    completed = subprocess.run(
        ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    resolved = completed.stdout.strip()
    if not resolved:
        raise RuntimeError("gh repo view returned an empty repository name")
    return resolved


def parse_paginated_json(output: str) -> list[object]:
    decoder = json.JSONDecoder()
    values: list[object] = []
    index = 0
    while index < len(output):
        while index < len(output) and output[index].isspace():
            index += 1
        if index >= len(output):
            break
        value, index = decoder.raw_decode(output, index)
        if isinstance(value, list):
            values.extend(value)
        else:
            values.append(value)
    return values


def fetch_pr_commits(pr_number: int, repo: str | None) -> list[PullRequestCommit]:
    resolved_repo = resolve_repo(repo)
    completed = subprocess.run(
        [
            "gh",
            "api",
            f"repos/{resolved_repo}/pulls/{pr_number}/commits",
            "--paginate",
        ],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    payload = parse_paginated_json(completed.stdout)
    return [
        PullRequestCommit(
            sha=str(item.get("sha") or ""),
            message=str((item.get("commit") or {}).get("message") or ""),
        )
        for item in payload
        if isinstance(item, dict)
    ]


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
        "valid_positive_remains_evidence",
        "Fixes #789\n\n"
        "## Issue closure gate\n\n"
        "- [x] #789: System remains stable after validation. No blockers remain.\n",
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
        "remaining_validation_evidence",
        "Fixes #123\n\n## Issue closure gate\n\n"
        "- [x] #123: implementation landed; remaining validation is post-merge.\n",
        False,
        "unresolved/blocking language",
    ),
    (
        "remaining_blocker_evidence",
        "Fixes #123\n\n## Issue closure gate\n\n"
        "- [x] #123: implementation landed; remaining blocker is owner review.\n",
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


UNIVERSAL_DONE_GATE_SELF_TESTS: tuple[tuple[str, str, bool, str | None], ...] = (
    (
        "valid_universal_done_gate_without_closing_keyword",
        "## Universal task Done gate\n\n"
        "- [x] Task type: docs/process.\n"
        "- [x] Expected observable outcome / named deliverable: reusable completion policy "
        "and checker support are documented.\n"
        "- [x] Non-goals / accepted substitutes: no GitHub Project mutation by this worker.\n"
        "- [x] Verification evidence required before Done: self-test and diff check pass.\n"
        "- [x] Project Evidence / Next action / Blocked by: controller will update Project "
        "Evidence and Next action; Blocked by remains empty because no blocker exists.\n"
        "- [x] Post-merge/deploy/runtime proof: not applicable for docs/process checker work.\n"
        "- [x] Named deliverable proof: not applicable; the task names no external surface.\n",
        True,
        None,
    ),
    (
        "missing_universal_done_gate_when_required",
        "## Summary\n\n- useful adjacent artifact exists.\n",
        False,
        "missing Universal task Done gate",
    ),
    (
        "universal_done_gate_missing_field",
        "## Universal task Done gate\n\n"
        "- [x] Task type: ops.\n"
        "- [x] Expected observable outcome / named deliverable: persistent service health.\n"
        "- [x] Non-goals / accepted substitutes: none.\n"
        "- [x] Verification evidence required before Done: service health check passes.\n"
        "- [x] Project Evidence / Next action / Blocked by: fields are current.\n"
        "- [x] Post-merge/deploy/runtime proof: service health is checked after deploy.\n",
        False,
        "missing checked field: Named deliverable proof",
    ),
    (
        "universal_done_gate_named_surface_requires_named_proof",
        "## Universal task Done gate\n\n"
        "- [x] Task type: dashboard/report.\n"
        "- [x] Expected observable outcome / named deliverable: Grafana dashboard is live.\n"
        "- [x] Non-goals / accepted substitutes: none.\n"
        "- [x] Verification evidence required before Done: local tests pass.\n"
        "- [x] Project Evidence / Next action / Blocked by: fields are current.\n"
        "- [x] Post-merge/deploy/runtime proof: runtime health check passed.\n"
        "- [x] Named deliverable proof: not applicable.\n",
        False,
        "names a deliverable surface",
    ),
    (
        "universal_done_gate_owner_accepted_substitute",
        "## Universal task Done gate\n\n"
        "- [x] Task type: dashboard/report.\n"
        "- [x] Expected observable outcome / named deliverable: Grafana dashboard is live.\n"
        "- [x] Non-goals / accepted substitutes: owner-accepted substitute is a static "
        "GitHub Pages report.\n"
        "- [x] Verification evidence required before Done: Pages URL and screenshot are captured.\n"
        "- [x] Project Evidence / Next action / Blocked by: fields are current with no blocker.\n"
        "- [x] Post-merge/deploy/runtime proof: post-merge Pages refresh is verified.\n"
        "- [x] Named deliverable proof: owner-accepted substitute recorded in Project Evidence.\n",
        True,
        None,
    ),
)


OPTIONAL_UNIVERSAL_DONE_GATE_SELF_TESTS: tuple[tuple[str, str, bool, str | None], ...] = (
    (
        "missing_optional_universal_done_gate_without_requirement",
        "## Summary\n\n- useful adjacent artifact exists.\n",
        True,
        None,
    ),
    (
        "present_optional_universal_done_gate_missing_field",
        "## Universal task Done gate\n\n"
        "- [x] Task type: ops.\n"
        "- [x] Expected observable outcome / named deliverable: persistent service health.\n"
        "- [x] Non-goals / accepted substitutes: none.\n"
        "- [x] Verification evidence required before Done: service health check passes.\n"
        "- [x] Project Evidence / Next action / Blocked by: fields are current.\n"
        "- [x] Post-merge/deploy/runtime proof: service health is checked after deploy.\n",
        False,
        "missing checked field: Named deliverable proof",
    ),
)


COMMIT_SELF_TESTS: tuple[tuple[str, PullRequestCommit, bool, str | None], ...] = (
    (
        "commit_clean_message",
        PullRequestCommit("abc1234567890", "docs: clarify non-closing linkage\n\nRelated to issue 123."),
        True,
        None,
    ),
    (
        "commit_closing_keyword",
        PullRequestCommit("abc1234567890", "fix(agent-os): fixes #123"),
        False,
        "commit abc1234: commit message contains GitHub closing keyword for #123",
    ),
    (
        "commit_negated_close",
        PullRequestCommit("fedcba9876543", "docs: does not close #123"),
        False,
        "commit fedcba9: line 1: ambiguous negated close-keyword phrase",
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
    for name, body, expect_pass, expected_message in UNIVERSAL_DONE_GATE_SELF_TESTS:
        errors = validate_body(body, require_universal_done_gate=True)
        passed = not errors
        if passed != expect_pass:
            failures.append(f"{name}: expected pass={expect_pass}, got errors={errors!r}")
            continue
        if expected_message and not any(expected_message in error for error in errors):
            failures.append(f"{name}: expected error containing {expected_message!r}, got {errors!r}")
    for name, body, expect_pass, expected_message in OPTIONAL_UNIVERSAL_DONE_GATE_SELF_TESTS:
        errors = validate_body(body)
        passed = not errors
        if passed != expect_pass:
            failures.append(f"{name}: expected pass={expect_pass}, got errors={errors!r}")
            continue
        if expected_message and not any(expected_message in error for error in errors):
            failures.append(f"{name}: expected error containing {expected_message!r}, got {errors!r}")
    for name, commit, expect_pass, expected_message in COMMIT_SELF_TESTS:
        errors = validate_commit_messages([commit])
        passed = not errors
        if passed != expect_pass:
            failures.append(f"{name}: expected pass={expect_pass}, got errors={errors!r}")
            continue
        if expected_message and not any(expected_message in error for error in errors):
            failures.append(f"{name}: expected error containing {expected_message!r}, got {errors!r}")
    paginated = parse_paginated_json('[{"sha": "a"}]\n[{"sha": "b"}]\n')
    if paginated != [{"sha": "a"}, {"sha": "b"}]:
        failures.append(f"paginated_json: expected two flattened objects, got {paginated!r}")
    if failures:
        print("FAIL: self-test")
        for failure in failures:
            print(f"- {failure}")
        return 1
    fixture_count = (
        len(SELF_TESTS)
        + len(UNIVERSAL_DONE_GATE_SELF_TESTS)
        + len(OPTIONAL_UNIVERSAL_DONE_GATE_SELF_TESTS)
        + len(COMMIT_SELF_TESTS)
    )
    print(f"PASS: self-test ({fixture_count} fixture(s))")
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
    parser.add_argument(
        "--require-universal-done-gate",
        action="store_true",
        help="require a checked Universal task Done gate section in the PR/issue completion evidence",
    )
    parser.add_argument("--self-test", action="store_true", help="run built-in validator fixtures")
    args = parser.parse_args()

    if not args.self_test and args.body_file is None and args.pr is None:
        parser.error("one of --self-test, --body-file, or --pr is required")

    exit_code = 0
    if args.self_test:
        exit_code = max(exit_code, run_self_tests())

    if args.body_file is not None:
        body = read_body_file(args.body_file)
        exit_code = max(
            exit_code,
            print_validation_result(
                body,
                validate_body(
                    body,
                    require_universal_done_gate=args.require_universal_done_gate,
                ),
            ),
        )
    elif args.pr is not None:
        try:
            body = fetch_pr_body(args.pr, args.repo)
            commits = fetch_pr_commits(args.pr, args.repo)
        except (OSError, RuntimeError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
            print(f"FAIL: unable to read PR data with gh: {exc}")
            return 1
        errors = [
            *validate_body(
                body,
                require_universal_done_gate=args.require_universal_done_gate,
            ),
            *validate_commit_messages(commits),
        ]
        exit_code = max(exit_code, print_validation_result(body, errors))

    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
