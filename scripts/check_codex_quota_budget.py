#!/usr/bin/env python3
"""Decide which Screeps Codex cron jobs may run under weekly quota.

The guard is intentionally repo-contained: it reads the expected cron surface
from docs/ops/cron-and-route-registry.md plus either a redacted quota JSON
export or local Codex session logs. It never mutates live Hermes cron state.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import check_cron_registry


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REGISTRY = REPO_ROOT / "docs" / "ops" / "cron-and-route-registry.md"
DEFAULT_SESSION_ROOT = Path("/root/.codex/sessions")
CODEX_SESSION_PATTERN = "rollout-*.jsonl"
CODEX_PROVIDER = "openai-codex"
DEFAULT_REMAINING_THRESHOLD_PERCENT = 10.0
DEFAULT_WEEKLY_WINDOW_MINUTES = 10080

# P0 runway protected by issue #1783. The registry criticality is still the
# primary source; these ids make the reserve explicit if a row is reclassified.
DEFAULT_RESERVED_CODEX_JOB_IDS = frozenset(
    {
        "f66ed36d7be0",  # autonomous continuation worker
        "1df5ef0c3835",  # runtime room alert text check
        "aed8362e4501",  # RL flywheel steward
    }
)

PERCENT_FIELDS = (
    "remaining_percent",
    "remainingPercent",
    "remaining_percentage",
    "remainingPercentage",
    "remaining",
)
USED_FIELDS = ("used_percent", "usedPercent", "used_percentage", "usedPercentage", "used")
RESET_FIELDS = ("resets_at", "resetsAt", "reset_at", "resetAt")
WINDOW_FIELDS = ("window_minutes", "windowMinutes", "window")


JsonObject = dict[str, Any]


@dataclass(frozen=True)
class QuotaSnapshot:
    source: str
    observed_at: datetime | None
    used_percent: float | None
    remaining_percent: float | None
    reset_at: datetime | None
    window_minutes: int | None


@dataclass(frozen=True)
class QuotaReadResult:
    snapshot: QuotaSnapshot | None
    errors: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()


def parse_timestamp(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return datetime.fromtimestamp(float(value), timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    try:
        return datetime.fromtimestamp(float(text), timezone.utc)
    except ValueError:
        pass
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def format_timestamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_number(mapping: Mapping[str, Any], fields: Sequence[str]) -> tuple[float | None, str | None]:
    for field in fields:
        if field not in mapping:
            continue
        value = mapping.get(field)
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None, f"{field} is not numeric: {value!r}"
        if not math.isfinite(number):
            return None, f"{field} is not finite: {value!r}"
        return number, None
    return None, None


def read_int(mapping: Mapping[str, Any], fields: Sequence[str]) -> int | None:
    number, error = read_number(mapping, fields)
    if error is not None or number is None:
        return None
    return int(number)


def read_reset_at(mapping: Mapping[str, Any]) -> tuple[datetime | None, str | None]:
    for field in RESET_FIELDS:
        if field not in mapping:
            continue
        value = mapping.get(field)
        parsed = parse_timestamp(value)
        if parsed is None:
            return None, f"{field} is not a timestamp: {value!r}"
        return parsed, None
    return None, None


def normalize_percent(value: float | None, field: str) -> tuple[float | None, str | None]:
    if value is None:
        return None, None
    if value < 0 or value > 100:
        return None, f"{field} outside 0..100: {value!r}"
    return value, None


def rate_limit_candidates(value: Any) -> Iterable[tuple[Mapping[str, Any], str]]:
    if not isinstance(value, Mapping):
        return
    yield value, "root"
    payload = value.get("payload")
    if isinstance(payload, Mapping):
        yield payload, "payload"
        rate_limits = payload.get("rate_limits")
        if isinstance(rate_limits, Mapping):
            yield rate_limits, "payload.rate_limits"
            for key, child in rate_limits.items():
                if isinstance(child, Mapping):
                    yield child, f"payload.rate_limits.{key}"
    rate_limits = value.get("rate_limits")
    if isinstance(rate_limits, Mapping):
        yield rate_limits, "rate_limits"
        for key, child in rate_limits.items():
            if isinstance(child, Mapping):
                yield child, f"rate_limits.{key}"
    for key in ("primary", "secondary", "weekly", "quota"):
        child = value.get(key)
        if isinstance(child, Mapping):
            yield child, key


def snapshot_from_mapping(
    value: Mapping[str, Any],
    *,
    source: str,
    target_window_minutes: int = DEFAULT_WEEKLY_WINDOW_MINUTES,
) -> tuple[QuotaSnapshot | None, tuple[str, ...]]:
    observed_at = parse_timestamp(value.get("timestamp") or value.get("observed_at") or value.get("observedAt"))
    errors: list[str] = []
    best: QuotaSnapshot | None = None

    for candidate, candidate_path in rate_limit_candidates(value):
        window_minutes = read_int(candidate, WINDOW_FIELDS)
        if window_minutes is not None and window_minutes != target_window_minutes:
            continue

        remaining, remaining_error = read_number(candidate, PERCENT_FIELDS)
        used, used_error = read_number(candidate, USED_FIELDS)
        reset_at, reset_error = read_reset_at(candidate)
        candidate_errors = [error for error in (remaining_error, used_error, reset_error) if error]
        if candidate_errors:
            errors.extend(f"{candidate_path}: {error}" for error in candidate_errors)
            continue
        if remaining is None and used is None:
            continue
        remaining, remaining_error = normalize_percent(remaining, "remaining_percent")
        used, used_error = normalize_percent(used, "used_percent")
        candidate_errors = [error for error in (remaining_error, used_error) if error]
        if candidate_errors:
            errors.extend(f"{candidate_path}: {error}" for error in candidate_errors)
            continue
        if remaining is None and used is not None:
            remaining = max(0.0, 100.0 - used)
        if used is None and remaining is not None:
            used = max(0.0, 100.0 - remaining)

        snapshot = QuotaSnapshot(
            source=f"{source}:{candidate_path}",
            observed_at=observed_at,
            used_percent=used,
            remaining_percent=remaining,
            reset_at=reset_at,
            window_minutes=window_minutes,
        )
        if window_minutes == target_window_minutes:
            return snapshot, tuple(errors)
        if best is None:
            best = snapshot

    return best, tuple(errors)


def snapshot_sort_key(snapshot: QuotaSnapshot) -> tuple[float, str]:
    observed = snapshot.observed_at.timestamp() if snapshot.observed_at is not None else 0.0
    return observed, snapshot.source


def load_quota_json(path: Path, *, target_window_minutes: int = DEFAULT_WEEKLY_WINDOW_MINUTES) -> QuotaReadResult:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        return QuotaReadResult(None, errors=(f"quota JSON unreadable: {path}: {exc}",))
    except json.JSONDecodeError as exc:
        return QuotaReadResult(None, errors=(f"quota JSON malformed: {path}: {exc}",))

    snapshots: list[QuotaSnapshot] = []
    errors: list[str] = []
    items = data if isinstance(data, list) else [data]
    for index, item in enumerate(items):
        if not isinstance(item, Mapping):
            errors.append(f"quota JSON item {index} is not an object")
            continue
        snapshot, item_errors = snapshot_from_mapping(
            item,
            source=f"{path}#{index}" if isinstance(data, list) else str(path),
            target_window_minutes=target_window_minutes,
        )
        errors.extend(item_errors)
        if snapshot is not None:
            snapshots.append(snapshot)
    if snapshots:
        return QuotaReadResult(max(snapshots, key=snapshot_sort_key), errors=tuple(errors))
    errors.append("no weekly quota telemetry found in quota JSON")
    return QuotaReadResult(None, errors=tuple(errors))


def scan_session_log(path: Path, *, target_window_minutes: int = DEFAULT_WEEKLY_WINDOW_MINUTES) -> QuotaReadResult:
    snapshots: list[QuotaSnapshot] = []
    errors: list[str] = []
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as handle:
            for line_number, line in enumerate(handle, start=1):
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(record, Mapping):
                    continue
                snapshot, item_errors = snapshot_from_mapping(
                    record,
                    source=f"{path}:{line_number}",
                    target_window_minutes=target_window_minutes,
                )
                errors.extend(item_errors)
                if snapshot is not None:
                    snapshots.append(snapshot)
    except OSError as exc:
        return QuotaReadResult(None, errors=(f"session log unreadable: {path}: {exc}",))
    if not snapshots:
        return QuotaReadResult(None, errors=tuple(errors))
    return QuotaReadResult(max(snapshots, key=snapshot_sort_key), errors=tuple(errors))


def find_session_logs(root: Path, *, max_files: int) -> list[Path]:
    def mtime(path: Path) -> float:
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0

    try:
        paths = [path for path in root.glob(f"**/{CODEX_SESSION_PATTERN}") if path.is_file()]
    except OSError:
        return []
    paths.sort(key=mtime, reverse=True)
    return paths[:max_files]


def load_quota_from_sessions(
    *,
    session_root: Path,
    session_logs: Sequence[Path] = (),
    max_session_files: int = 200,
    target_window_minutes: int = DEFAULT_WEEKLY_WINDOW_MINUTES,
) -> QuotaReadResult:
    paths = list(session_logs)
    if not paths:
        if not session_root.exists():
            return QuotaReadResult(None, errors=(f"Codex session root does not exist: {session_root}",))
        paths = find_session_logs(session_root, max_files=max_session_files)
    if not paths:
        return QuotaReadResult(None, errors=("no Codex session logs found",))

    snapshots: list[QuotaSnapshot] = []
    errors: list[str] = []
    for path in paths:
        result = scan_session_log(path, target_window_minutes=target_window_minutes)
        errors.extend(result.errors)
        if result.snapshot is not None:
            snapshots.append(result.snapshot)
    if snapshots:
        return QuotaReadResult(max(snapshots, key=snapshot_sort_key), errors=tuple(errors))
    errors.append("no weekly quota telemetry found in Codex session logs")
    return QuotaReadResult(None, errors=tuple(errors))


def quota_status(
    snapshot: QuotaSnapshot | None,
    *,
    now: datetime,
    threshold_remaining_percent: float,
    errors: Sequence[str] = (),
) -> JsonObject:
    base: JsonObject = {
        "thresholdRemainingPercent": threshold_remaining_percent,
        "errors": list(errors),
    }
    if snapshot is None:
        return {
            **base,
            "state": "UNKNOWN_QUOTA",
            "effectiveRemainingPercent": None,
            "reason": "weekly quota telemetry is missing or malformed",
            "source": None,
        }

    observed_remaining = snapshot.remaining_percent
    observed_used = snapshot.used_percent
    reset_elapsed = snapshot.reset_at is not None and now >= snapshot.reset_at
    if reset_elapsed:
        state = "RESET_ELAPSED"
        effective_remaining = 100.0
        effective_used = 0.0
        reason = "weekly quota reset time has elapsed; suppressed jobs are eligible again"
    elif observed_remaining is None:
        state = "UNKNOWN_QUOTA"
        effective_remaining = None
        effective_used = None
        reason = "weekly quota remaining percent is unavailable"
    elif observed_remaining < threshold_remaining_percent:
        state = "LOW_QUOTA"
        effective_remaining = observed_remaining
        effective_used = observed_used
        reason = "weekly quota remaining percent is below threshold"
    else:
        state = "HEALTHY_QUOTA"
        effective_remaining = observed_remaining
        effective_used = observed_used
        reason = "weekly quota remaining percent is at or above threshold"

    return {
        **base,
        "state": state,
        "reason": reason,
        "source": snapshot.source,
        "observedAt": format_timestamp(snapshot.observed_at),
        "resetAt": format_timestamp(snapshot.reset_at),
        "resetElapsed": reset_elapsed,
        "windowMinutes": snapshot.window_minutes,
        "observedUsedPercent": observed_used,
        "observedRemainingPercent": observed_remaining,
        "effectiveUsedPercent": effective_used,
        "effectiveRemainingPercent": effective_remaining,
    }


def is_codex_job(spec: Mapping[str, Any]) -> bool:
    return str(spec.get("provider") or "").strip() == CODEX_PROVIDER


def is_protected_codex_job(
    job_id: str,
    spec: Mapping[str, Any],
    *,
    reserved_job_ids: set[str],
) -> tuple[bool, str | None]:
    if not is_codex_job(spec):
        return False, None
    criticality = str(spec.get("criticality") or "").strip().upper()
    if criticality == "P0":
        return True, "criticality:P0"
    if job_id in reserved_job_ids:
        return True, "reserved_codex_job_id"
    return False, None


def evaluate_budget(
    expected_jobs: Mapping[str, Mapping[str, Any]],
    quota: QuotaReadResult,
    *,
    now: datetime,
    threshold_remaining_percent: float = DEFAULT_REMAINING_THRESHOLD_PERCENT,
    reserved_job_ids: set[str] | None = None,
) -> JsonObject:
    reserved = set(DEFAULT_RESERVED_CODEX_JOB_IDS if reserved_job_ids is None else reserved_job_ids)
    quota_info = quota_status(
        quota.snapshot,
        now=now,
        threshold_remaining_percent=threshold_remaining_percent,
        errors=quota.errors,
    )
    suppress_non_p0 = quota_info["state"] in {"LOW_QUOTA", "UNKNOWN_QUOTA"}

    decisions: list[JsonObject] = []
    for job_id, spec in sorted(expected_jobs.items()):
        codex_job = is_codex_job(spec)
        protected, protected_by = is_protected_codex_job(job_id, spec, reserved_job_ids=reserved)
        criticality = str(spec.get("criticality") or "").strip() or None
        if not codex_job:
            decision = "ALLOW"
            reason = "not_codex_provider"
        elif protected:
            decision = "ALLOW"
            reason = protected_by or "protected_codex_job"
        elif suppress_non_p0:
            decision = "SUPPRESS"
            reason = quota_info["state"].lower()
        else:
            decision = "ALLOW"
            reason = quota_info["state"].lower()
        decisions.append(
            {
                "id": job_id,
                "job": spec.get("job"),
                "provider": spec.get("provider"),
                "model": spec.get("model"),
                "criticality": criticality,
                "codex": codex_job,
                "protected": protected,
                "protectedBy": protected_by,
                "decision": decision,
                "reason": reason,
            }
        )

    suppressed = [item for item in decisions if item["decision"] == "SUPPRESS"]
    codex_jobs = [item for item in decisions if item["codex"]]
    protected_codex = [item for item in codex_jobs if item["protected"]]
    status = "ALLOW_ALL"
    if quota_info["state"] == "UNKNOWN_QUOTA":
        status = "UNKNOWN_QUOTA"
    elif suppressed:
        status = "SUPPRESSING"

    return {
        "ok": True,
        "status": status,
        "now": format_timestamp(now),
        "dispatchPolicy": "suppress_non_p0_codex" if suppress_non_p0 else "allow_all",
        "quota": quota_info,
        "summary": {
            "totalJobs": len(decisions),
            "codexJobs": len(codex_jobs),
            "protectedCodexJobs": len(protected_codex),
            "nonProtectedCodexJobs": len(codex_jobs) - len(protected_codex),
            "allowedCount": len(decisions) - len(suppressed),
            "suppressedCount": len(suppressed),
            "suppressedJobIds": [item["id"] for item in suppressed],
        },
        "decisions": decisions,
    }


def parse_reserved_ids(values: Sequence[str]) -> set[str]:
    if not values:
        return set(DEFAULT_RESERVED_CODEX_JOB_IDS)
    result: set[str] = set()
    for value in values:
        for item in value.split(","):
            normalized = item.strip()
            if normalized:
                result.add(normalized)
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--quota-json", type=Path, help="redacted quota JSON fixture/export")
    parser.add_argument(
        "--session-root",
        type=Path,
        default=DEFAULT_SESSION_ROOT,
        help="Codex session root to scan when --quota-json is not provided",
    )
    parser.add_argument("--session-log", type=Path, action="append", default=[], help="specific Codex session JSONL file to scan")
    parser.add_argument("--max-session-files", type=int, default=200)
    parser.add_argument("--window-minutes", type=int, default=DEFAULT_WEEKLY_WINDOW_MINUTES)
    parser.add_argument("--threshold-remaining-percent", type=float, default=DEFAULT_REMAINING_THRESHOLD_PERCENT)
    parser.add_argument("--now", help="UTC timestamp override for deterministic tests")
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON; accepted for checker parity")
    parser.add_argument(
        "--reserve-job-id",
        action="append",
        default=[],
        help="protected Codex job id; comma-separated values accepted; overrides defaults when supplied",
    )
    parser.add_argument("--job-id", help="only print the decision for one job id")
    parser.add_argument("--strict", action="store_true", help="exit nonzero if the selected scope contains a suppression")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    now = parse_timestamp(args.now) if args.now else datetime.now(timezone.utc)
    if now is None:
        print(json.dumps({"ok": False, "error": f"invalid --now timestamp: {args.now!r}"}, sort_keys=True), file=sys.stderr)
        return 2
    expected = check_cron_registry.parse_registry(args.registry)
    quota = (
        load_quota_json(args.quota_json, target_window_minutes=args.window_minutes)
        if args.quota_json is not None
        else load_quota_from_sessions(
            session_root=args.session_root,
            session_logs=args.session_log,
            max_session_files=max(1, args.max_session_files),
            target_window_minutes=args.window_minutes,
        )
    )
    result = evaluate_budget(
        expected,
        quota,
        now=now,
        threshold_remaining_percent=args.threshold_remaining_percent,
        reserved_job_ids=parse_reserved_ids(args.reserve_job_id),
    )
    if args.job_id:
        decisions = [item for item in result["decisions"] if item["id"] == args.job_id]
        result = {**result, "decisions": decisions, "selectedJobId": args.job_id}
        if not decisions:
            result["ok"] = False
            result["status"] = "UNKNOWN_JOB"

    print(json.dumps(result, indent=2, sort_keys=True, ensure_ascii=True))
    if args.strict:
        if result.get("status") == "UNKNOWN_JOB":
            return 2
        if any(item.get("decision") == "SUPPRESS" for item in result.get("decisions", [])):
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
