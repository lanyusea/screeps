#!/usr/bin/env python3
"""Create GitHub issues from accepted Gameplay Evolution review findings."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence, TextIO
from urllib.parse import quote


DEFAULT_REPO = "lanyusea/screeps"
DEFAULT_PROJECT_OWNER = "lanyusea"
DEFAULT_PROJECT_NUMBER = 3
DEFAULT_PROJECT_FIELDS = {
    "Status": "Backlog",
    "Domain": "Gameplay Evolution",
}
DEFAULT_PARENT_ISSUE = "#59"
DEFAULT_MILESTONE = "Phase C: Runtime telemetry / monitor gate"
DEFAULT_LABELS = (
    "priority:p1",
    "roadmap",
    "kind:code",
    "roadmap:gameplay-evolution",
)
TITLE_PREFIX = "P1: [Gameplay Evolution]"

JsonObject = dict[str, Any]


@dataclass(frozen=True)
class IntakeField:
    key: str
    label: str
    aliases: tuple[str, ...]


@dataclass(frozen=True)
class IssuePlan:
    index: int
    title: str
    body: str
    source_artifact: str


@dataclass(frozen=True)
class ProjectFieldOption:
    field_id: str
    option_id: str


@dataclass(frozen=True)
class ProjectContext:
    project_id: str
    options: dict[str, ProjectFieldOption]


class InputError(Exception):
    """Raised when the findings input cannot be converted into issues."""


class GhError(Exception):
    """Raised when a GitHub CLI command fails or returns unexpected data."""


INTAKE_FIELDS = (
    IntakeField("evidence_window", "Evidence window", ("evidenceWindow", "evidence_window", "Evidence window")),
    IntakeField("shard_room", "Shard / room", ("shardRoom", "shard_room", "Shard / room")),
    IntakeField(
        "code_version_deployed_commit",
        "Code version / deployed commit",
        (
            "codeVersionDeployedCommit",
            "code_version_deployed_commit",
            "deployedCommit",
            "deployed_commit",
            "Code version / deployed commit",
        ),
    ),
    IntakeField(
        "served_vision_layer",
        "Served vision layer",
        ("servedVisionLayer", "served_vision_layer", "visionLayer", "vision_layer", "Served vision layer"),
    ),
    IntakeField(
        "kpi_delta_observed",
        "KPI delta observed",
        ("kpiDeltaObserved", "kpi_delta_observed", "KPI delta observed"),
    ),
    IntakeField(
        "reliability_guardrails_observed",
        "Reliability guardrails observed",
        (
            "reliabilityGuardrailsObserved",
            "reliability_guardrails_observed",
            "Reliability guardrails observed",
        ),
    ),
    IntakeField("hypothesis", "Hypothesis", ("hypothesis", "Hypothesis")),
    IntakeField("target_area", "Target area", ("targetArea", "target_area", "Target area")),
    IntakeField(
        "expected_kpi_movement",
        "Expected KPI movement",
        ("expectedKpiMovement", "expected_kpi_movement", "Expected KPI movement"),
    ),
    IntakeField(
        "acceptance_evidence",
        "Acceptance evidence",
        ("acceptanceEvidence", "acceptance_evidence", "Acceptance evidence"),
    ),
    IntakeField(
        "rollback_stop_condition",
        "Rollback / stop condition",
        ("rollbackStopCondition", "rollback_stop_condition", "Rollback / stop condition"),
    ),
    IntakeField(
        "no_secret_considerations",
        "No-secret considerations",
        ("noSecretConsiderations", "no_secret_considerations", "No-secret considerations"),
    ),
)

SOURCE_ARTIFACT_ALIASES = (
    "sourceReviewArtifact",
    "source_review_artifact",
    "reviewArtifact",
    "review_artifact",
    "sourceArtifact",
    "source_artifact",
    "artifact",
)
TITLE_ALIASES = ("title", "issueTitle", "issue_title", "findingTitle", "finding_title", "summary")


class GhRunner:
    def run(self, args: Sequence[str]) -> str:
        completed = subprocess.run(args, text=True, capture_output=True, check=False)
        if completed.returncode != 0:
            raise GhError(
                f"command failed ({completed.returncode}): {format_command(args)}\n"
                f"{completed.stderr.strip() or completed.stdout.strip()}"
            )
        return completed.stdout.strip()


def normalize_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def value_index(raw: JsonObject) -> dict[str, Any]:
    return {normalize_key(str(key)): value for key, value in raw.items()}


def lookup(raw: JsonObject, aliases: Sequence[str]) -> Any:
    indexed = value_index(raw)
    for alias in aliases:
        key = normalize_key(alias)
        if key in indexed:
            return indexed[key]
    return None


def format_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return " ".join(value.strip().split())
    if isinstance(value, list):
        return "; ".join(format_value(item) for item in value if format_value(item))
    if isinstance(value, dict):
        return json.dumps(value, sort_keys=True, separators=(",", ":"))
    return str(value)


def require_text(raw: JsonObject, aliases: Sequence[str], label: str, *, finding_index: int) -> str:
    text = format_value(lookup(raw, aliases))
    if not text:
        raise InputError(f"finding {finding_index}: missing required field: {label}")
    return text


def issue_title(raw: JsonObject, *, finding_index: int) -> str:
    title = require_text(raw, TITLE_ALIASES, "title", finding_index=finding_index)
    if "\n" in title or "\r" in title:
        raise InputError(f"finding {finding_index}: title must be a single line")
    if title.startswith(TITLE_PREFIX):
        return title
    return f"{TITLE_PREFIX} {title}"


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def artifact_markdown(source_artifact: str, *, repo: str, root: Path) -> str:
    if source_artifact.startswith("http://") or source_artifact.startswith("https://"):
        return f"<{source_artifact}>"

    path = Path(source_artifact)
    display = source_artifact
    if path.is_absolute():
        try:
            display = str(path.resolve().relative_to(root.resolve()))
        except ValueError:
            display = source_artifact

    if display and not display.startswith("/") and not re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", display):
        quoted = quote(display)
        return f"[{display}](https://github.com/{repo}/blob/main/{quoted})"
    return display


def optional_text(raw: JsonObject, aliases: Sequence[str], fallback: str) -> str:
    value = format_value(lookup(raw, aliases))
    return value or fallback


def inferred_codex_required(raw: JsonObject) -> str:
    explicit = format_value(lookup(raw, ("codexRequiredForProd", "codex_required_for_prod", "Codex required for `prod/`")))
    if explicit:
        return explicit
    haystack = " ".join(
        optional_text(raw, aliases, "")
        for aliases in (
            ("targetArea", "target_area"),
            ("scope",),
            ("filesSubsystemsExpected", "files_subsystems_expected", "files", "subsystems"),
        )
    )
    return "yes" if "prod" in haystack.lower() else "no"


def default_verification(raw: JsonObject) -> str:
    explicit = format_value(lookup(raw, ("verification", "Verification")))
    if explicit:
        return explicit
    if inferred_codex_required(raw) == "yes":
        return "`cd prod && npm run typecheck`; `cd prod && npm test -- --runInBand`; `cd prod && npm run build`"
    return "narrow script/docs verification plus dry-run evidence"


def build_issue_body(raw: JsonObject, *, source_artifact: str, repo: str, root: Path) -> str:
    intake_lines = [
        "## Accepted Gameplay Evolution finding",
        f"- Parent: {DEFAULT_PARENT_ISSUE} Gameplay Evolution vision-driven loop",
        f"- Source review artifact: {artifact_markdown(source_artifact, repo=repo, root=root)}",
    ]
    for field in INTAKE_FIELDS:
        value = require_text(raw, field.aliases, field.label, finding_index=int(raw["_finding_index"]))
        intake_lines.append(f"- {field.label}: {value}")

    scope = optional_text(raw, ("scope", "Scope"), optional_text(raw, ("targetArea", "target_area"), "Not specified"))
    files = optional_text(
        raw,
        ("filesSubsystemsExpected", "files_subsystems_expected", "files", "subsystems", "Files / subsystems expected"),
        "Not specified",
    )

    return "\n".join(
        [
            *intake_lines,
            "",
            "## Implementation target",
            f"- Scope: {scope}",
            f"- Files / subsystems expected: {files}",
            f"- Codex required for `prod/`: {inferred_codex_required(raw)}",
            f"- Verification: {default_verification(raw)}",
            "",
            "## Acceptance criteria",
            "- [ ] GitHub issue and Project fields are current.",
            "- [ ] Implementation preserves no-secret policy.",
            "- [ ] If `prod/` changes, Codex authors the code commit and `npm run typecheck`, `npm test -- --runInBand`, and `npm run build` pass from `prod/`.",
            "- [ ] PR is in Project `screeps` and passes the automated review gate.",
            "- [ ] Runtime/private/monitor evidence is attached when release or gameplay KPI movement is claimed.",
        ]
    )


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise InputError(f"input file not found: {path}") from error
    except json.JSONDecodeError as error:
        raise InputError(f"invalid JSON in {path}: {error}") from error


def raw_findings(document: Any) -> tuple[list[JsonObject], JsonObject]:
    if isinstance(document, list):
        findings = document
        metadata: JsonObject = {}
    elif isinstance(document, dict):
        metadata = document
        if "findings" in document:
            findings = document["findings"]
        else:
            findings = [document]
    else:
        raise InputError("input must be a JSON object or array")

    if not isinstance(findings, list):
        raise InputError("findings must be an array")
    if not findings:
        raise InputError("findings array is empty")
    for index, finding in enumerate(findings, start=1):
        if not isinstance(finding, dict):
            raise InputError(f"finding {index}: expected object")
    return findings, metadata


def build_issue_plans(path: Path, *, repo: str = DEFAULT_REPO) -> list[IssuePlan]:
    document = load_json(path)
    findings, metadata = raw_findings(document)
    root = repo_root()
    default_source = format_value(lookup(metadata, SOURCE_ARTIFACT_ALIASES))
    plans: list[IssuePlan] = []

    for index, finding in enumerate(findings, start=1):
        finding_with_index = dict(finding)
        finding_with_index["_finding_index"] = index
        source_artifact = format_value(lookup(finding_with_index, SOURCE_ARTIFACT_ALIASES)) or default_source
        if not source_artifact:
            raise InputError(f"finding {index}: missing required source review artifact")
        plans.append(
            IssuePlan(
                index=index,
                title=issue_title(finding_with_index, finding_index=index),
                body=build_issue_body(finding_with_index, source_artifact=source_artifact, repo=repo, root=root),
                source_artifact=source_artifact,
            )
        )
    return plans


def format_command(args: Sequence[str]) -> str:
    rendered = []
    for arg in args:
        if re.search(r"[\s'\"$]", arg):
            rendered.append("'" + arg.replace("'", "'\"'\"'") + "'")
        else:
            rendered.append(arg)
    return " ".join(rendered)


def parse_json_output(raw: str, *, command: str) -> JsonObject:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise GhError(f"{command} did not return valid JSON: {raw}") from error
    if not isinstance(parsed, dict):
        raise GhError(f"{command} returned unexpected JSON shape")
    return parsed


def list_from_json_node(raw: Any) -> list[JsonObject]:
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    if isinstance(raw, dict):
        if isinstance(raw.get("nodes"), list):
            return [item for item in raw["nodes"] if isinstance(item, dict)]
        if isinstance(raw.get("items"), list):
            return [item for item in raw["items"] if isinstance(item, dict)]
    return []


def project_id_from_view(raw: JsonObject) -> str:
    for key in ("id", "projectId", "project_id"):
        value = format_value(raw.get(key))
        if value:
            return value
    raise GhError("gh project view output did not include a project id")


def fields_from_output(raw: JsonObject) -> list[JsonObject]:
    for key in ("fields", "items", "nodes"):
        fields = list_from_json_node(raw.get(key))
        if fields:
            return fields
    raise GhError("gh project field-list output did not include fields")


def field_option(fields: Sequence[JsonObject], *, field_name: str, option_name: str) -> ProjectFieldOption:
    for field in fields:
        if format_value(field.get("name")) != field_name:
            continue
        field_id = format_value(field.get("id"))
        if not field_id:
            raise GhError(f"project field {field_name!r} is missing an id")
        for option in list_from_json_node(field.get("options")):
            if format_value(option.get("name")) == option_name:
                option_id = format_value(option.get("id"))
                if option_id:
                    return ProjectFieldOption(field_id=field_id, option_id=option_id)
        raise GhError(f"project field {field_name!r} has no option {option_name!r}")
    raise GhError(f"project field {field_name!r} was not found")


def load_project_context(
    runner: GhRunner,
    *,
    owner: str,
    project_number: int,
    field_values: dict[str, str],
) -> ProjectContext:
    view_command = ["gh", "project", "view", str(project_number), "--owner", owner, "--format", "json"]
    project_view = parse_json_output(runner.run(view_command), command=format_command(view_command))
    field_command = [
        "gh",
        "project",
        "field-list",
        str(project_number),
        "--owner",
        owner,
        "--limit",
        "100",
        "--format",
        "json",
    ]
    fields = fields_from_output(parse_json_output(runner.run(field_command), command=format_command(field_command)))
    return ProjectContext(
        project_id=project_id_from_view(project_view),
        options={
            field_name: field_option(fields, field_name=field_name, option_name=option_name)
            for field_name, option_name in field_values.items()
        },
    )


def issue_create_command(plan: IssuePlan, *, repo: str, body_file: str) -> list[str]:
    command = [
        "gh",
        "issue",
        "create",
        "--repo",
        repo,
        "--title",
        plan.title,
        "--body-file",
        body_file,
        "--milestone",
        DEFAULT_MILESTONE,
    ]
    for label in DEFAULT_LABELS:
        command.extend(["--label", label])
    return command


def issue_url_from_output(raw: str) -> str:
    match = re.search(r"https://github\.com/[^\s]+/issues/\d+", raw)
    if match:
        return match.group(0)
    stripped = raw.strip()
    if stripped.startswith("https://github.com/"):
        return stripped
    raise GhError(f"gh issue create output did not include an issue URL: {raw}")


def create_issue(plan: IssuePlan, *, runner: GhRunner, repo: str) -> str:
    body_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".md", delete=False) as body_file:
            body_file.write(plan.body)
            body_path = Path(body_file.name)
        return issue_url_from_output(runner.run(issue_create_command(plan, repo=repo, body_file=str(body_path))))
    finally:
        if body_path is not None:
            body_path.unlink(missing_ok=True)


def project_item_id_from_output(raw: str) -> str:
    parsed = parse_json_output(raw, command="gh project item-add")
    for key in ("id", "itemId", "item_id"):
        value = format_value(parsed.get(key))
        if value:
            return value
    item = parsed.get("item")
    if isinstance(item, dict):
        value = format_value(item.get("id"))
        if value:
            return value
    raise GhError(f"gh project item-add output did not include an item id: {raw}")


def add_issue_to_project(
    issue_url: str,
    *,
    runner: GhRunner,
    owner: str,
    project_number: int,
    project_context: ProjectContext,
) -> None:
    add_command = [
        "gh",
        "project",
        "item-add",
        str(project_number),
        "--owner",
        owner,
        "--url",
        issue_url,
        "--format",
        "json",
    ]
    item_id = project_item_id_from_output(runner.run(add_command))
    for option in project_context.options.values():
        runner.run(
            [
                "gh",
                "project",
                "item-edit",
                "--id",
                item_id,
                "--project-id",
                project_context.project_id,
                "--field-id",
                option.field_id,
                "--single-select-option-id",
                option.option_id,
            ]
        )


def dry_run(plans: Sequence[IssuePlan], *, stdout: TextIO, repo: str, project_owner: str, project_number: int) -> None:
    print(f"DRY RUN: would create {len(plans)} issue(s) in {repo}", file=stdout)
    print(
        f"Project: {project_owner}/{project_number} with "
        + ", ".join(f"{field}={value}" for field, value in DEFAULT_PROJECT_FIELDS.items()),
        file=stdout,
    )
    print(f"Milestone: {DEFAULT_MILESTONE}", file=stdout)
    print(f"Labels: {', '.join(DEFAULT_LABELS)}", file=stdout)
    for plan in plans:
        print("", file=stdout)
        print(f"--- Finding {plan.index} ---", file=stdout)
        print(f"Title: {plan.title}", file=stdout)
        print(f"Source review artifact: {plan.source_artifact}", file=stdout)
        print("Would run:", file=stdout)
        print(format_command(issue_create_command(plan, repo=repo, body_file="<temporary-body-file>")), file=stdout)
        print(
            format_command(
                [
                    "gh",
                    "project",
                    "item-add",
                    str(project_number),
                    "--owner",
                    project_owner,
                    "--url",
                    "<created-issue-url>",
                    "--format",
                    "json",
                ]
            ),
            file=stdout,
        )
        for field_name, value in DEFAULT_PROJECT_FIELDS.items():
            print(f"gh project item-edit <created-project-item> # {field_name}={value}", file=stdout)
        print("Body:", file=stdout)
        print(plan.body, file=stdout)


def create_from_plans(
    plans: Sequence[IssuePlan],
    *,
    runner: GhRunner,
    stdout: TextIO,
    repo: str,
    project_owner: str,
    project_number: int,
) -> int:
    project_context = load_project_context(
        runner,
        owner=project_owner,
        project_number=project_number,
        field_values=DEFAULT_PROJECT_FIELDS,
    )
    for plan in plans:
        issue_url = create_issue(plan, runner=runner, repo=repo)
        add_issue_to_project(
            issue_url,
            runner=runner,
            owner=project_owner,
            project_number=project_number,
            project_context=project_context,
        )
        print(issue_url, file=stdout)
    return 0


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create GitHub issues from accepted Gameplay Evolution review findings."
    )
    parser.add_argument("findings_json", type=Path, help="JSON file containing a findings array or a single finding")
    parser.add_argument("--dry-run", action="store_true", help="print planned issue/project actions without creating")
    parser.add_argument("--repo", default=DEFAULT_REPO, help=f"GitHub repository (default: {DEFAULT_REPO})")
    parser.add_argument(
        "--project-owner",
        default=DEFAULT_PROJECT_OWNER,
        help=f"GitHub Project owner (default: {DEFAULT_PROJECT_OWNER})",
    )
    parser.add_argument(
        "--project-number",
        type=int,
        default=DEFAULT_PROJECT_NUMBER,
        help=f"GitHub Project number (default: {DEFAULT_PROJECT_NUMBER})",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None, *, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr, runner: GhRunner | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    try:
        plans = build_issue_plans(args.findings_json, repo=args.repo)
        if args.dry_run:
            dry_run(
                plans,
                stdout=stdout,
                repo=args.repo,
                project_owner=args.project_owner,
                project_number=args.project_number,
            )
            return 0
        return create_from_plans(
            plans,
            runner=runner or GhRunner(),
            stdout=stdout,
            repo=args.repo,
            project_owner=args.project_owner,
            project_number=args.project_number,
        )
    except (InputError, GhError) as error:
        print(f"error: {error}", file=stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
