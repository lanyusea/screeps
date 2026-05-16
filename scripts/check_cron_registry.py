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
EXPECTED_SECTION = "## Expected recurring cron jobs"


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
        rows[jid] = {
            "job": empty_to_none(row.get("job")),
            "schedule": empty_to_none(row.get("schedule")),
            "deliver": empty_to_none(row.get("delivery")),
            "provider": empty_to_none(row.get("provider")),
            "model": empty_to_none(row.get("model")),
            "workdir": empty_to_none(row.get("workdir")),
            "repeat": empty_to_none(row.get("repeat")),
            "criticality": empty_to_none(row.get("criticality")),
        }
    if not rows:
        raise ValueError(f"No expected cron rows parsed from {path}")
    return rows


def load_live_jobs(path: Path) -> Dict[str, Dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    jobs = data.get("jobs") if isinstance(data, dict) else data
    if isinstance(jobs, dict):
        jobs = list(jobs.values())
    if not isinstance(jobs, list):
        raise ValueError(f"Unsupported jobs.json structure in {path}")
    live: Dict[str, Dict[str, Any]] = {}
    for job in jobs:
        if not isinstance(job, dict):
            continue
        jid = job.get("id") or job.get("job_id")
        if jid:
            live[str(jid)] = job
    return live


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


def compare(expected: Dict[str, Dict[str, Optional[str]]], live: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    missing_expected: List[Dict[str, Any]] = []
    unexpected_live: List[Dict[str, Any]] = []
    mismatches: List[Dict[str, Any]] = []

    for jid, spec in sorted(expected.items()):
        job = live.get(jid)
        if not job:
            missing_expected.append({"id": jid, "job": spec.get("job")})
            continue
        if job.get("enabled") is not True or job.get("state") != "scheduled":
            mismatches.append({
                "id": jid,
                "job": spec.get("job") or job.get("name"),
                "field": "enabled/state",
                "expected": "enabled=true,state=scheduled",
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
        if expected_workdir:
            if expected_workdir != live_workdir:
                mismatches.append({
                    "id": jid,
                    "job": spec.get("job") or job.get("name"),
                    "field": "workdir",
                    "expected": expected_workdir,
                    "live": live_workdir,
                })
        elif live_workdir:
            mismatches.append({
                "id": jid,
                "job": spec.get("job") or job.get("name"),
                "field": "workdir",
                "expected": None,
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
            unexpected_live.append({
                "id": jid,
                "job": job.get("name"),
                "enabled": job.get("enabled"),
                "state": job.get("state"),
                "schedule": live_schedule(job),
                "deliver": job.get("deliver"),
            })

    status = "PASS" if not missing_expected and not unexpected_live and not mismatches else "FAIL"
    return {
        "status": status,
        "expected_count": len(expected),
        "live_count": len(live),
        "missing_expected": missing_expected,
        "unexpected_live": unexpected_live,
        "mismatches": mismatches,
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
    print(f"- mismatches: {len(result['mismatches'])}")
    for item in result["mismatches"]:
        print(f"  - {item['id']} {item.get('job')} {item['field']}: expected={item.get('expected')!r} live={item.get('live')!r}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--jobs-json", type=Path, default=DEFAULT_JOBS)
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON")
    parser.add_argument("--strict", action="store_true", help="exit nonzero on drift")
    args = parser.parse_args()

    expected = parse_registry(args.registry)
    live = load_live_jobs(args.jobs_json)
    result = compare(expected, live)

    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False, sort_keys=True))
    else:
        print_text(result)

    if args.strict and result["status"] != "PASS":
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
