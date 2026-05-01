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

CURRENT_ROOM = "E26S49"
OLD_ROOMS = ("E48S28", "E48S29")
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
        if path.exists() and CURRENT_ROOM not in path.read_text(errors="ignore"):
            add(errors, f"current room {CURRENT_ROOM} not found in operational file {path.relative_to(root)}")

    for rel in ["docs/ops/rules-registry.md", "docs/ops/cron-and-route-registry.md"]:
        text = (root / rel).read_text(errors="ignore")
        for old in OLD_ROOMS:
            if old in text and not re.search(rf"{old}.{{0,80}}(historical|superseded|previous|old)|(?:historical|superseded|previous|old).{{0,80}}{old}", text, re.I | re.S):
                add(errors, f"{rel} mentions {old} without historical/superseded wording")

    pr_template = (root / ".github/pull_request_template.md").read_text(errors="ignore")
    for token in ["Domain", "Kind", "Project", "QA", "Deployment Floor"]:
        if token not in pr_template:
            add(errors, f"PR template missing {token} gate")

    issue_template = (root / ".github/ISSUE_TEMPLATE/known_problem.yml").read_text(errors="ignore")
    for domain in DOMAINS:
        if domain not in issue_template:
            add(errors, f"issue template missing Domain option {domain}")
    if "<优先级>:<roadmap>" in issue_template:
        add(errors, "issue template still requires old title taxonomy parsing")

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
