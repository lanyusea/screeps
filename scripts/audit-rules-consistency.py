#!/usr/bin/env python3
"""Lightweight Screeps rules consistency audit.

This is intentionally small: it checks the drift risks that can make agents act on
wrong room/cadence/taxonomy facts. It is not a complete governance platform.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path
from typing import Any

import screeps_world_profiles as world_profiles

CURRENT_ROOM = world_profiles.PERSISTENT_DEFAULTS.room
OLD_ROOMS = ("W3N9", "E48S28", "E48S29", "E26S49", "E24S49", "E19S55", "E22S49", "E17S59", "E19S57")
DOMAINS = {
    "Agent OS",
    "Change-control",
    "Runtime monitor",
    "Release/deploy",
    "Bot capability",
    "Combat",
    "Territory/Economy",
    "Gameplay Evolution",
    "RL flywheel",
    "Docs/process",
}
KINDS = {"bug", "ops", "docs", "test", "code", "review", "research", "qa"}


def run(cmd: list[str], cwd: Path) -> str:
    return subprocess.check_output(cmd, cwd=cwd, text=True, stderr=subprocess.STDOUT)


def load_json(cmd: list[str], cwd: Path) -> Any:
    return json.loads(run(cmd, cwd))


def add(errors: list[str], message: str) -> None:
    errors.append(message)


def check_repo_files(root: Path, errors: list[str], warnings: list[str]) -> None:
    required = [
        root / "docs/ops/rules-registry.md",
        root / "docs/ops/cron-and-route-registry.md",
        root / ".github/ISSUE_TEMPLATE/config.yml",
        root / ".github/ISSUE_TEMPLATE/known_problem.yml",
        root / ".github/pull_request_template.md",
        root / ".github/workflows/issue-completion-gate.yml",
        root / "scripts/check_issue_completion_gate.py",
        root / "scripts/generate-roadmap-page.py",
    ]
    for path in required:
        if not path.exists():
            add(errors, f"missing required file: {path.relative_to(root)}")

    operational_files = [
        root / "AGENTS.md",
        root / "README.md",
        root / "docs/ops/rules-registry.md",
        root / "docs/ops/cron-and-route-registry.md",
        root / "docs/ops/official-mmo-deploy.md",
        root / "docs/ops/runtime-room-monitor.md",
        root / ".github/workflows/official-screeps-deploy.yml",
        root / "scripts/generate-roadmap-page.py",
        root / "scripts/screeps-runtime-monitor.py",
        root / "scripts/screeps_official_deploy.py",
    ]
    for path in operational_files:
        text = path.read_text(errors="ignore") if path.exists() else ""
        uses_central_room_profile = (
            "screeps_world_profiles" in text and "PERSISTENT_DEFAULTS.room" in text
        )
        if path.exists() and CURRENT_ROOM not in text and not uses_central_room_profile:
            add(errors, f"current room {CURRENT_ROOM} not found in operational file {path.relative_to(root)}")

    for rel in ["docs/ops/rules-registry.md", "docs/ops/cron-and-route-registry.md"]:
        text = (root / rel).read_text(errors="ignore")
        for old in OLD_ROOMS:
            qualifier = "historical|superseded|previous|old|fallback|audit"
            if old in text and not re.search(rf"{old}.{{0,140}}({qualifier})|(?:{qualifier}).{{0,140}}{old}", text, re.I | re.S):
                add(errors, f"{rel} mentions {old} without historical/superseded wording")

    pr_template = (root / ".github/pull_request_template.md").read_text(errors="ignore")
    for token in ["Domain", "Kind", "Project", "QA", "Deployment Floor"]:
        if token not in pr_template:
            add(errors, f"PR template missing {token} gate")
    for token in ["Issue closure gate", "Related to issue", "non-closing"]:
        if token not in pr_template:
            add(errors, f"PR template missing acceptance-first closure guidance token: {token}")

    issue_template = (root / ".github/ISSUE_TEMPLATE/known_problem.yml").read_text(errors="ignore")
    for domain in DOMAINS:
        if domain not in issue_template:
            add(errors, f"issue template missing Domain option {domain}")
    if "<优先级>:<roadmap>" in issue_template:
        add(errors, "issue template still requires old title taxonomy parsing")

    acceptance_files = [
        ".github/ISSUE_TEMPLATE/known_problem.yml",
        "docs/ops/github-issue-management.md",
        "docs/ops/github-roadmap-management.md",
        "docs/ops/agent-operating-system.md",
    ]
    for rel in acceptance_files:
        text = (root / rel).read_text(errors="ignore")
        if "acceptance-first" not in text.lower():
            add(errors, f"{rel} missing acceptance-first issue closure rule")
    for rel in [
        ".github/ISSUE_TEMPLATE/known_problem.yml",
        "docs/ops/github-issue-management.md",
        "docs/ops/github-roadmap-management.md",
    ]:
        text = (root / rel).read_text(errors="ignore")
        forbidden_patterns = [
            r"Every PR that fixes a known problem must link its issue in the PR body with a GitHub closing keyword before merge",
            r"Fix PR must link this issue with a closing keyword before merge",
            r"Link implementation PRs with closing keywords",
            r"PRs that complete a known issue must use GitHub closing keywords",
        ]
        for pattern in forbidden_patterns:
            if re.search(pattern, text, re.I):
                add(errors, f"{rel} contains old unconditional closing-keyword wording: {pattern}")

    script = (root / "scripts/generate-roadmap-page.py").read_text(errors="ignore")
    for domain in DOMAINS:
        if domain not in script:
            add(errors, f"roadmap generator missing Domain {domain}")
    for old_domain in ["Private smoke", "Official MMO"]:
        if f'"{old_domain}"' in script:
            warnings.append(f"roadmap generator still has legacy domain literal {old_domain}; ensure it is alias-only if intentional")


def check_github(root: Path, errors: list[str], warnings: list[str]) -> None:
    try:
        issues = load_json([
            "gh", "issue", "list", "--repo", "lanyusea/screeps", "--state", "open", "--limit", "200",
            "--json", "number,title,labels,milestone,projectItems"
        ], root)
        prs = load_json([
            "gh", "pr", "list", "--repo", "lanyusea/screeps", "--state", "open", "--limit", "100",
            "--json", "number,title,projectItems"
        ], root)
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"GitHub live audit skipped: {exc}")
        return

    for issue in issues:
        labels = {label.get("name") for label in issue.get("labels", [])}
        if "roadmap" in labels:
            if not issue.get("milestone"):
                add(errors, f"open roadmap issue #{issue['number']} missing milestone")
            if not issue.get("projectItems"):
                add(errors, f"open roadmap issue #{issue['number']} missing Project item")
    for pr in prs:
        if not pr.get("projectItems"):
            add(errors, f"open PR #{pr['number']} missing Project item")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=".", help="repository root")
    parser.add_argument("--github", action="store_true", help="include live GitHub checks")
    args = parser.parse_args()
    root = Path(args.repo).resolve()
    errors: list[str] = []
    warnings: list[str] = []

    check_repo_files(root, errors, warnings)
    if args.github:
        check_github(root, errors, warnings)

    for warning in warnings:
        print(f"WARN: {warning}")
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        print(f"FAIL: {len(errors)} error(s), {len(warnings)} warning(s)")
        return 1
    print(f"PASS: rules consistency audit ({len(warnings)} warning(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
