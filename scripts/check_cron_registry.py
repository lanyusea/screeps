#!/usr/bin/env python3
"""Check live Hermes cron jobs against the Screeps cron registry.

Default mode prints a safe summary and exits 0 so the script can be used as
scheduled-job context. Use --strict for CI/acceptance: drift exits nonzero.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REGISTRY = REPO_ROOT / "docs" / "ops" / "cron-and-route-registry.md"
DEFAULT_JOBS = Path("/root/.hermes/cron/jobs.json")
DEFAULT_SHADOW_EVAL_SOURCE = Path("/root/.hermes/scripts/screeps-rl-shadow-eval-bounded.py")
EXPECTED_SECTION = "## Expected recurring cron jobs"
NO_WORKDIR = "__NO_DURABLE_CRON_WORKDIR__"
SHADOW_EVAL_JOB_ID = "d6cff532edd4"
SHADOW_EVAL_JOB_NAME = "Screeps RL shadow-eval bounded gate"
SHADOW_EVAL_NO_UMBRELLA_EXPECTED = (
    "shadow-eval routine output/comment routing must not target historical issue #879"
)
SHADOW_EVAL_FORBIDDEN_PATTERNS: Tuple[Tuple[str, re.Pattern[str]], ...] = (
    ("legacy_github_issue_879_status", re.compile(r"\bgithub_issue_879_comment\b")),
    ("issue_879_url_or_api_route", re.compile(r"(?<![\w-])issues/879(?:\b|[#/?])", re.IGNORECASE)),
    (
        "gh_issue_comment_879",
        re.compile(r"\bgh\s+issue\s+comment\s+[`\"']?#?879\b", re.IGNORECASE),
    ),
    (
        "github_issue_879_target",
        re.compile(r"\bgithub[_-]?issue(?:[_-]?(?:number|id))?\s*[:=]\s*[\"']?#?879\b", re.IGNORECASE),
    ),
    (
        "comment_issue_879_target",
        re.compile(
            r"\b(?:comment[_-]?issue|issue[_-]?comment[_-]?target|github[_-]?comment[_-]?target|"
            r"comment[_-]?target|target[_-]?issue|issue[_-]?number)\s*[:=]\s*[\"']?#?879\b",
            re.IGNORECASE,
        ),
    ),
)

ISSUE_COMMENT_SINK_EXPECTED = (
    "cron producer prompts must write routine metrics/status to artifacts first and may only "
    "comment one exact open atomic issue when that issue's acceptance evidence, blocker, "
    "status, next action, PR state, or owner-decision state materially changes"
)
ISSUE_COMMENT_SINK_HISTORICAL_IDS = "879|893|1589"
ISSUE_COMMENT_SINK_FORBIDDEN_PATTERNS: Tuple[Tuple[str, re.Pattern[str]], ...] = (
    (
        "fixed_issue_comment_fanout",
        re.compile(
            r"\b(?:comment|post|write|send)\s+#?\d+\b"
            r"(?=[^\n.]{0,200}\b(?:plus|and)\b[^\n.]{0,200}\batomic\s+issue)",
            re.IGNORECASE,
        ),
    ),
    (
        "historical_issue_comment_target",
        re.compile(
            rf"(?:\bgh\s+issue\s+comment\s+[`\"']?#?(?:{ISSUE_COMMENT_SINK_HISTORICAL_IDS})\b|"
            rf"(?<![\w-])issues/(?:{ISSUE_COMMENT_SINK_HISTORICAL_IDS})/comments(?:\b|[#/?])|"
            rf"\b(?:comment|post|write|send)\s+(?:to\s+)?#?(?:{ISSUE_COMMENT_SINK_HISTORICAL_IDS})\b|"
            rf"\bissue\s+comment\s+(?:to|target)\s+#?(?:{ISSUE_COMMENT_SINK_HISTORICAL_IDS})\b)",
            re.IGNORECASE,
        ),
    ),
    (
        "fixed_historical_source_issue",
        re.compile(rf"\bsourceIssue\s*[:=]\s*[`\"']?#?(?:{ISSUE_COMMENT_SINK_HISTORICAL_IDS})\b", re.IGNORECASE),
    ),
    (
        "fixed_historical_tracking_surface",
        re.compile(rf"\btracking\s+surfaces?\s*:\s*#?(?:{ISSUE_COMMENT_SINK_HISTORICAL_IDS})\b", re.IGNORECASE),
    ),
)


def strip_md(value: str) -> str:
    value = value.strip()
    if value.startswith("`") and value.endswith("`") and len(value) >= 2:
        value = value[1:-1]
    return value.strip()


def empty_to_none(value: Any) -> Optional[str]:
    if value is None:
        return None
    s = str(value).strip()
    if not s or s == "-" or s.lower() == "null":
        return None
    return s


def normalize_header(value: str) -> str:
    return strip_md(value).lower().replace(" ", "_").replace("-", "_")


def split_md_row(line: str) -> List[str]:
    # The registry table intentionally avoids literal pipe characters inside
    # cells, so a simple split is sufficient and easier to audit.
    return [c.strip() for c in line.strip().strip("|").split("|")]


def normalize_expected_workdir(value: Any) -> Optional[str]:
    raw = strip_md(str(value)) if value is not None else ""
    if not raw or raw in {"-", "—"} or raw.lower() == "null":
        return NO_WORKDIR
    return raw


def parse_registry(path: Path) -> Dict[str, Dict[str, Optional[str]]]:
    text = path.read_text(encoding="utf-8")
    in_expected = False
    headers: Optional[List[str]] = None
    rows: Dict[str, Dict[str, Optional[str]]] = {}

    for raw in text.splitlines():
        line = raw.rstrip()
        if line.startswith("## "):
            in_expected = line.strip() == EXPECTED_SECTION
            headers = None
            continue
        if not in_expected or not line.startswith("|"):
            continue
        cols = split_md_row(line)
        if not cols or all(set(c) <= {"-", ":"} for c in cols):
            continue
        if headers is None:
            headers = [normalize_header(c) for c in cols]
            continue
        if len(cols) != len(headers):
            raise ValueError(f"Malformed registry row has {len(cols)} cells, expected {len(headers)}: {line}")
        row = {headers[i]: strip_md(cols[i]) for i in range(len(headers))}
        jid = empty_to_none(row.get("id"))
        if not jid:
            continue
        if jid in rows:
            raise ValueError(f"Duplicate cron job id in registry: {jid}")
        rows[jid] = {
            "job": empty_to_none(row.get("job")),
            "schedule": empty_to_none(row.get("schedule")),
            "deliver": empty_to_none(row.get("delivery")),
            "provider": empty_to_none(row.get("provider")),
            "model": empty_to_none(row.get("model")),
            "workdir": normalize_expected_workdir(row.get("workdir")),
            "repeat": empty_to_none(row.get("repeat")),
            "criticality": empty_to_none(row.get("criticality")),
        }
    if not rows:
        raise ValueError(f"No expected cron rows parsed from {path}")
    return rows


def load_live_jobs(path: Path) -> Dict[str, Dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    jobs = data.get("jobs") if isinstance(data, dict) else data
    live: Dict[str, Dict[str, Any]] = {}
    if isinstance(jobs, dict):
        iterator = jobs.items()
        for key, job in iterator:
            if not isinstance(job, dict):
                continue
            jid = job.get("id") or job.get("job_id") or key
            live[str(jid)] = job
        return live
    if not isinstance(jobs, list):
        raise ValueError(f"Unsupported jobs.json structure in {path}")
    for job in jobs:
        if not isinstance(job, dict):
            continue
        jid = job.get("id") or job.get("job_id")
        if jid:
            live[str(jid)] = job
    return live


def match_line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def match_excerpt(text: str, start: int, end: int, window: int = 80) -> str:
    excerpt_start = max(0, start - window)
    excerpt_end = min(len(text), end + window)
    excerpt = text[excerpt_start:excerpt_end].replace("\n", "\\n")
    if excerpt_start > 0:
        excerpt = "..." + excerpt
    if excerpt_end < len(text):
        excerpt += "..."
    return excerpt


def shadow_eval_no_umbrella_violations(surface: str, text: str) -> List[Dict[str, Any]]:
    violations: List[Dict[str, Any]] = []
    seen: set[Tuple[str, int]] = set()
    for pattern_name, pattern in SHADOW_EVAL_FORBIDDEN_PATTERNS:
        for match in pattern.finditer(text):
            line = match_line_number(text, match.start())
            key = (pattern_name, line)
            if key in seen:
                continue
            seen.add(key)
            violations.append({
                "id": SHADOW_EVAL_JOB_ID,
                "job": SHADOW_EVAL_JOB_NAME,
                "surface": surface,
                "field": "shadow_eval_no_umbrella",
                "pattern": pattern_name,
                "line": line,
                "expected": SHADOW_EVAL_NO_UMBRELLA_EXPECTED,
                "live": match_excerpt(text, match.start(), match.end()),
            })
    return violations


def append_shadow_eval_path_violations(violations: List[Dict[str, Any]], surface: str, path: Path) -> None:
    if not path.exists():
        return
    if not path.is_file():
        return
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        violations.append({
            "id": SHADOW_EVAL_JOB_ID,
            "job": SHADOW_EVAL_JOB_NAME,
            "surface": surface,
            "field": "shadow_eval_no_umbrella",
            "pattern": "unreadable_surface",
            "line": None,
            "expected": SHADOW_EVAL_NO_UMBRELLA_EXPECTED,
            "live": f"{path}: {exc}",
        })
        return
    violations.extend(shadow_eval_no_umbrella_violations(f"{surface}:{path}", text))


def validate_shadow_eval_no_umbrella(
    live: Dict[str, Dict[str, Any]],
    source_path: Optional[Path] = DEFAULT_SHADOW_EVAL_SOURCE,
    output_paths: Optional[List[Path]] = None,
    text_surfaces: Optional[Dict[str, str]] = None,
) -> List[Dict[str, Any]]:
    violations: List[Dict[str, Any]] = []
    job = live.get(SHADOW_EVAL_JOB_ID)
    if job:
        job_text = json.dumps(job, ensure_ascii=False, sort_keys=True, default=str)
        violations.extend(shadow_eval_no_umbrella_violations(f"live job {SHADOW_EVAL_JOB_ID}", job_text))

    if source_path is not None:
        append_shadow_eval_path_violations(violations, "shadow-eval source", source_path)
    for output_path in output_paths or []:
        append_shadow_eval_path_violations(violations, "shadow-eval output", output_path)
    for surface, text in (text_surfaces or {}).items():
        violations.extend(shadow_eval_no_umbrella_violations(surface, text))
    return violations


def is_negated_policy_context(text: str, start: int) -> bool:
    """Return true when a forbidden-looking phrase is only a prohibition/example."""
    context = text[max(0, start - 96):start].lower()
    return bool(
        re.search(
            r"(?:do\s+not|don't|never|must\s+not|forbid(?:den)?|not\s+(?:a|an|the)?\s*"
            r"(?:progress|comment|target|sink)|no\s+(?:routine\s+)?comments?)",
            context,
        )
    )


def issue_comment_sink_violations(
    job_id: str,
    job_name: Optional[str],
    surface: str,
    text: str,
) -> List[Dict[str, Any]]:
    violations: List[Dict[str, Any]] = []
    seen: set[Tuple[str, int]] = set()
    for pattern_name, pattern in ISSUE_COMMENT_SINK_FORBIDDEN_PATTERNS:
        for match in pattern.finditer(text):
            if pattern_name != "fixed_historical_source_issue" and is_negated_policy_context(text, match.start()):
                continue
            line = match_line_number(text, match.start())
            key = (pattern_name, line)
            if key in seen:
                continue
            seen.add(key)
            violations.append({
                "id": job_id,
                "job": job_name,
                "surface": surface,
                "field": "issue_comment_sink_policy",
                "pattern": pattern_name,
                "line": line,
                "expected": ISSUE_COMMENT_SINK_EXPECTED,
                "live": match_excerpt(text, match.start(), match.end()),
            })
    return violations


def validate_issue_comment_sink_policy(
    live: Dict[str, Dict[str, Any]],
    text_surfaces: Optional[Dict[str, str]] = None,
) -> List[Dict[str, Any]]:
    """Reject cron prompts that resurrect fixed GitHub issues as routine ledgers.

    Historical issue IDs may appear as context, but producer prompts must not
    instruct agents to write routine comments to them, use them as tracking
    surfaces, or stamp them as the source issue for generated ledgers.
    """
    violations: List[Dict[str, Any]] = []
    for jid, job in sorted(live.items()):
        prompt = job.get("prompt")
        if not isinstance(prompt, str) or not prompt:
            continue
        violations.extend(issue_comment_sink_violations(jid, empty_to_none(job.get("name")), f"live job {jid} prompt", prompt))
    for surface, text in (text_surfaces or {}).items():
        violations.extend(issue_comment_sink_violations("__text__", None, surface, text))
    return violations


def live_schedule(job: Dict[str, Any]) -> Optional[str]:
    schedule = job.get("schedule")
    if isinstance(schedule, dict):
        return empty_to_none(schedule.get("display") or schedule.get("expr") or schedule.get("kind"))
    return empty_to_none(schedule)


def normalize_live_repeat(live_value: Any) -> str:
    if isinstance(live_value, dict):
        times = live_value.get("times")
        completed = live_value.get("completed", 0)
        if times is None:
            return "forever"
        return f"{completed}/{times}"
    return empty_to_none(live_value) or ""


def is_live_one_shot(job: Dict[str, Any]) -> bool:
    repeat = job.get("repeat")
    if isinstance(repeat, dict):
        try:
            return int(repeat.get("times", 0)) == 1
        except (TypeError, ValueError):
            return False
    normalized = normalize_live_repeat(repeat)
    if normalized == "once":
        return True
    if "/" in normalized:
        try:
            _completed, total = normalized.split("/", 1)
            return int(total) == 1
        except ValueError:
            return False
    return False


def repeat_matches(expected: Optional[str], live_value: Any) -> Tuple[bool, str]:
    exp = empty_to_none(expected)
    live = normalize_live_repeat(live_value)
    if not exp:
        return True, live
    if exp == "forever":
        return live == "forever", live
    if exp == "once":
        return live == "once", live
    if exp == "high-horizon":
        if live == "forever":
            return True, live
        if live and "/" in live:
            try:
                _used, limit = live.split("/", 1)
                return int(limit) >= 999999, live
            except ValueError:
                return False, live
        return False, live
    return exp == live, live


def compare(
    expected: Dict[str, Dict[str, Optional[str]]],
    live: Dict[str, Dict[str, Any]],
    policy_violations: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    missing_expected: List[Dict[str, Any]] = []
    unexpected_live: List[Dict[str, Any]] = []
    ignored_one_shot_live: List[Dict[str, Any]] = []
    mismatches: List[Dict[str, Any]] = []
    policy_violations = policy_violations or []

    for jid, spec in sorted(expected.items()):
        job = live.get(jid)
        if not job:
            missing_expected.append({"id": jid, "job": spec.get("job")})
            continue
        # A recurring job can be healthy while it is actively executing. Treat
        # both `scheduled` and `running` as acceptable enabled states so the
        # monitor does not raise false drift during a legitimate run.
        healthy_states = {"scheduled", "running"}
        if job.get("enabled") is not True or job.get("state") not in healthy_states:
            mismatches.append({
                "id": jid,
                "job": spec.get("job") or job.get("name"),
                "field": "enabled/state",
                "expected": "enabled=true,state in {scheduled,running}",
                "live": f"enabled={job.get('enabled')},state={job.get('state')}",
            })
        checks = [
            ("name", spec.get("job"), empty_to_none(job.get("name"))),
            ("schedule", spec.get("schedule"), live_schedule(job)),
            ("deliver", spec.get("deliver"), empty_to_none(job.get("deliver"))),
            ("provider", spec.get("provider"), empty_to_none(job.get("provider"))),
            ("model", spec.get("model"), empty_to_none(job.get("model"))),
        ]
        for field, exp, got in checks:
            if exp and exp != got:
                mismatches.append({
                    "id": jid,
                    "job": spec.get("job") or job.get("name"),
                    "field": field,
                    "expected": exp,
                    "live": got,
                })
        expected_workdir = spec.get("workdir")
        live_workdir = empty_to_none(job.get("workdir"))
        if expected_workdir == NO_WORKDIR:
            if live_workdir:
                mismatches.append({
                    "id": jid,
                    "job": spec.get("job") or job.get("name"),
                    "field": "workdir",
                    "expected": None,
                    "live": live_workdir,
                })
        elif expected_workdir:
            if expected_workdir != live_workdir:
                mismatches.append({
                    "id": jid,
                    "job": spec.get("job") or job.get("name"),
                    "field": "workdir",
                    "expected": expected_workdir,
                    "live": live_workdir,
                })
        ok, live_repeat = repeat_matches(spec.get("repeat"), job.get("repeat"))
        if not ok:
            mismatches.append({
                "id": jid,
                "job": spec.get("job") or job.get("name"),
                "field": "repeat",
                "expected": spec.get("repeat"),
                "live": live_repeat,
            })

    for jid, job in sorted(live.items()):
        if jid not in expected:
            if is_live_one_shot(job):
                ignored_one_shot_live.append({
                    "id": jid,
                    "job": job.get("name"),
                    "enabled": job.get("enabled"),
                    "state": job.get("state"),
                    "schedule": live_schedule(job),
                    "deliver": job.get("deliver"),
                    "repeat": normalize_live_repeat(job.get("repeat")),
                })
                continue
            unexpected_live.append({
                "id": jid,
                "job": job.get("name"),
                "enabled": job.get("enabled"),
                "state": job.get("state"),
                "schedule": live_schedule(job),
                "deliver": job.get("deliver"),
            })

    status = "PASS" if not missing_expected and not unexpected_live and not mismatches and not policy_violations else "FAIL"
    return {
        "status": status,
        "expected_count": len(expected),
        "live_count": len(live),
        "missing_expected": missing_expected,
        "unexpected_live": unexpected_live,
        "ignored_one_shot_live": ignored_one_shot_live,
        "mismatches": mismatches,
        "policy_violations": policy_violations,
    }


def print_text(result: Dict[str, Any]) -> None:
    print(f"Cron registry check: {result['status']}")
    print(f"- expected recurring jobs: {result['expected_count']}")
    print(f"- live jobs: {result['live_count']}")
    print(f"- missing expected: {len(result['missing_expected'])}")
    for item in result["missing_expected"]:
        print(f"  - {item['id']} {item.get('job')}")
    print(f"- unexpected live: {len(result['unexpected_live'])}")
    for item in result["unexpected_live"]:
        print(f"  - {item['id']} {item.get('job')} enabled={item.get('enabled')} state={item.get('state')} schedule={item.get('schedule')}")
    print(f"- ignored live one-shot jobs: {len(result.get('ignored_one_shot_live', []))}")
    for item in result.get("ignored_one_shot_live", []):
        print(f"  - {item['id']} {item.get('job')} enabled={item.get('enabled')} state={item.get('state')} schedule={item.get('schedule')}")
    print(f"- mismatches: {len(result['mismatches'])}")
    for item in result["mismatches"]:
        print(f"  - {item['id']} {item.get('job')} {item['field']}: expected={item.get('expected')!r} live={item.get('live')!r}")
    print(f"- policy violations: {len(result.get('policy_violations', []))}")
    for item in result.get("policy_violations", []):
        line = item.get("line")
        line_text = f":{line}" if line is not None else ""
        print(
            f"  - {item['id']} {item.get('job')} {item.get('surface')}{line_text} "
            f"{item.get('pattern')}: expected={item.get('expected')!r} live={item.get('live')!r}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--jobs-json", type=Path, default=DEFAULT_JOBS)
    parser.add_argument(
        "--shadow-eval-source",
        type=Path,
        default=DEFAULT_SHADOW_EVAL_SOURCE,
        help="optional shadow-eval bounded source path to scan; absent paths are skipped",
    )
    parser.add_argument(
        "--shadow-eval-output",
        type=Path,
        action="append",
        default=[],
        help="optional shadow-eval output/artifact path to scan; may be repeated",
    )
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON")
    parser.add_argument("--strict", action="store_true", help="exit nonzero on drift")
    args = parser.parse_args()

    expected = parse_registry(args.registry)
    live = load_live_jobs(args.jobs_json)
    policy_violations = validate_shadow_eval_no_umbrella(
        live,
        source_path=args.shadow_eval_source,
        output_paths=args.shadow_eval_output,
    )
    policy_violations.extend(validate_issue_comment_sink_policy(live))
    result = compare(expected, live, policy_violations=policy_violations)

    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False, sort_keys=True))
    else:
        print_text(result)

    if args.strict and result["status"] != "PASS":
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
