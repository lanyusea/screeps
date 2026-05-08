#!/usr/bin/env python3
"""Safe official Screeps MMO deploy helper.

The script uploads the built Screeps bundle as one ``main`` module and reports
only metadata and hashes. It intentionally never logs tokens, auth headers, or
module contents.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ARTIFACT_PATH = REPO_ROOT / "prod" / "dist" / "main.js"
DEFAULT_EVIDENCE_DIR = REPO_ROOT / "runtime-artifacts" / "official-screeps-deploy"
DEFAULT_API_URL = "https://screeps.com"
DEFAULT_BRANCH = "main"
DEFAULT_SHARD = "shardX"
DEFAULT_ROOM = "E26S49"
DEFAULT_TIMEOUT_SECONDS = 30
DEFAULT_MONITOR_TIMEOUT_SECONDS = 120
DEFAULT_ROLLBACK_RECOVERY_TIMEOUT_SECONDS = 300
DEFAULT_ROLLBACK_RECOVERY_POLL_SECONDS = 15
AUTH_TOKEN_ENV = "SCREEPS_AUTH_TOKEN"
SECRET_KEY_RE = re.compile(r"(authorization|password|secret|steam[_-]?key|token|x[_-]?token|x[_-]?username)", re.I)
BRANCH_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
SHARD_RE = re.compile(r"^[A-Za-z0-9_-]+$")
ROOM_RE = re.compile(r"^[WE]\d+[NS]\d+$")
ROLLBACK_TRIGGER_REASON_KINDS = {
    "room_dead",
    "postdeploy_room_dead",
    "no_owned_spawn",
    "postdeploy_no_owned_spawn",
}
ROLLBACK_SOURCE_PATHS = (
    "prod/src",
    "prod/package.json",
    "prod/package-lock.json",
    "prod/tsconfig.json",
    "prod/tsconfig.build.json",
    "prod/jest.config.cjs",
)
ROLLBACK_ISSUE_TITLE = "P0: Auto-rollback deployed after room_dead health gate failure"


class DeployError(RuntimeError):
    """A sanitized deploy failure that can be printed safely."""


@dataclass(frozen=True)
class DeployConfig:
    """Configuration for a dry-run or live official deploy."""

    api_url: str
    branch: str
    shard: str
    room: str
    artifact_path: Path
    deploy: bool
    activate_world: bool
    confirm: str | None = None
    clone_source_branch: str | None = None
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    evidence_path: Path | None = None
    evidence_dir: Path = DEFAULT_EVIDENCE_DIR
    auto_rollback: bool = False
    rollback_recovery_timeout_seconds: int = DEFAULT_ROLLBACK_RECOVERY_TIMEOUT_SECONDS
    rollback_recovery_poll_seconds: int = DEFAULT_ROLLBACK_RECOVERY_POLL_SECONDS
    repo_root: Path = REPO_ROOT

    @property
    def expected_confirmation(self) -> str:
        """Return the exact confirmation phrase required for writes."""
        return f"deploy {self.branch} to {self.shard}/{self.room}"


@dataclass
class HttpResult:
    """HTTP response status, decoded payload, and headers."""

    status: int
    payload: Any
    headers: dict[str, str]


@dataclass(frozen=True)
class PreviousDeployEvidence:
    """Previous deploy evidence paired with its successful health gate."""

    commit: str
    deploy_path: Path
    health_gate_path: Path
    deploy: dict[str, Any]
    health_gate: dict[str, Any]
    sort_key: str


@dataclass
class ScreepsApi:
    """Small authenticated Screeps API client with safe request summaries."""

    base_url: str
    token: str
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    transport: Callable[..., HttpResult] | None = None
    requests: list[dict[str, Any]] = field(default_factory=list)

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> HttpResult:
        """Send an authenticated JSON request and record a safe summary."""
        headers = {"X-Token": self.token}
        request_summary: dict[str, Any] = {
            "method": method,
            "path": path,
            "params": params or {},
            "payload": summarize_request_payload(path, payload),
        }
        transport = self.transport or http_json
        try:
            result = transport(
                method=method,
                base_url=self.base_url,
                path=path,
                payload=payload,
                headers=headers,
                params=params,
                timeout=self.timeout_seconds,
            )
        except DeployError as exc:
            raise DeployError(short_text(redact(str(exc), [self.token]), 500)) from None
        request_summary["status"] = result.status
        request_summary["apiOk"] = api_payload_succeeded(result)
        self.requests.append(request_summary)
        return result

    def list_branches(self) -> HttpResult:
        """Return the current Screeps code branches."""
        return self.request("GET", "/api/user/branches")

    def clone_branch(self, source_branch: str, new_name: str) -> HttpResult:
        """Clone an existing code branch to a new branch name."""
        return self.request("POST", "/api/user/clone-branch", {"branch": source_branch, "newName": new_name})

    def upload_code(self, branch: str, code: str) -> HttpResult:
        """Upload the ``main`` module to a Screeps code branch."""
        return self.request("POST", "/api/user/code", build_code_payload(branch, code))

    def get_code(self, branch: str) -> HttpResult:
        """Fetch code for a branch or Screeps pseudo-branch such as ``$activeWorld``."""
        return self.request("GET", "/api/user/code", params={"branch": branch})

    def set_active_world_branch(self, branch: str) -> HttpResult:
        """Set the active World branch without exposing the module body."""
        return self.request(
            "POST",
            "/api/user/set-active-branch",
            {"activeName": "activeWorld", "branch": branch},
        )


def normalize_api_url(raw_url: str) -> str:
    """Normalize and validate the official HTTPS API base URL."""
    parsed = urllib.parse.urlparse(raw_url.strip())
    if parsed.scheme != "https" or parsed.netloc != "screeps.com":
        raise DeployError("SCREEPS_API_URL must be https://screeps.com for official deploys")
    if parsed.username or parsed.password:
        raise DeployError("SCREEPS_API_URL must not include credentials")
    if parsed.query or parsed.fragment:
        raise DeployError("SCREEPS_API_URL must not include query strings or fragments")
    if parsed.path.rstrip("/"):
        raise DeployError("SCREEPS_API_URL must not include path prefixes")
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, "", "", "", ""))


def require_https_api_url(api_url: str) -> None:
    """Reject non-official API URLs before authenticated deploy requests."""
    parsed = urllib.parse.urlparse(api_url)
    if parsed.scheme != "https" or parsed.netloc != "screeps.com":
        raise DeployError("SCREEPS_API_URL must be https://screeps.com for --deploy")


def validate_selector(name: str, value: str, pattern: re.Pattern[str]) -> str:
    """Validate a non-secret branch/shard/room selector."""
    if not pattern.fullmatch(value):
        raise DeployError(f"{name} has an unsupported value: {value}")
    return value


def git_output(repo_root: Path, *args: str) -> str:
    """Return git command stdout, or ``unknown`` when git metadata is unavailable."""
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=repo_root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    if result.returncode != 0:
        return "unknown"
    return result.stdout.strip() or "unknown"


def git_metadata(repo_root: Path) -> dict[str, Any]:
    """Return local commit metadata suitable for deploy evidence."""
    status = git_output(repo_root, "status", "--short")
    return {
        "commit": git_output(repo_root, "rev-parse", "HEAD"),
        "branch": git_output(repo_root, "branch", "--show-current"),
        "dirty": bool(status and status != "unknown"),
    }


def read_artifact(path: Path) -> tuple[bytes, dict[str, Any]]:
    """Read a deploy artifact and return safe metadata."""
    if not path.exists():
        raise DeployError(f"artifact does not exist: {path}")
    if not path.is_file():
        raise DeployError(f"artifact is not a file: {path}")
    data = path.read_bytes()
    if not data:
        raise DeployError(f"artifact is empty: {path}")
    return data, artifact_metadata_from_bytes(path, data)


def artifact_metadata_from_bytes(path: Path, data: bytes) -> dict[str, Any]:
    """Return non-secret artifact evidence for bytes."""
    return {
        "path": safe_path(path),
        "sizeBytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def safe_path(path: Path) -> str:
    """Return a stable repo-relative path when possible."""
    try:
        return str(path.resolve().relative_to(REPO_ROOT.resolve()))
    except ValueError:
        return str(path)


def decode_module(data: bytes, path: Path) -> str:
    """Decode the bundle as UTF-8 for Screeps module upload."""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise DeployError(f"artifact must be UTF-8 JavaScript: {path}") from exc


def build_code_payload(branch: str, code: str) -> dict[str, Any]:
    """Build the official Screeps code upload payload."""
    return {
        "branch": branch,
        "modules": {
            "main": code,
        },
    }


def summarize_modules(modules: dict[str, Any]) -> dict[str, Any]:
    """Summarize module names, sizes, and hashes without returning contents."""
    summary: dict[str, Any] = {}
    for name, value in modules.items():
        if isinstance(value, str):
            encoded = value.encode("utf-8")
            summary[name] = {
                "redacted": True,
                "sizeBytes": len(encoded),
                "sha256": hashlib.sha256(encoded).hexdigest(),
            }
        else:
            summary[name] = {"redacted": True, "type": type(value).__name__}
    return summary


def summarize_request_payload(path: str, payload: dict[str, Any] | None) -> dict[str, Any]:
    """Return a request-body summary that cannot contain code or tokens."""
    if not payload:
        return {}
    if path == "/api/user/code":
        modules = payload.get("modules")
        return {
            "branch": payload.get("branch"),
            "modules": summarize_modules(modules) if isinstance(modules, dict) else {"redacted": True},
        }
    return redact(payload)


CODE_LEAK_MARKERS = ("module.exports", "exports.loop")
CODE_LIKE_TEXT_KEYS = {"main", "message", "error", "body", "detail"}


def looks_like_code_leak(text: str, parent_key: str) -> bool:
    """Return whether a free-text API field appears to contain uploaded code."""
    if parent_key == "main":
        return len(text) > 120 or any(marker in text for marker in CODE_LEAK_MARKERS)
    if parent_key in CODE_LIKE_TEXT_KEYS:
        return any(marker in text for marker in CODE_LEAK_MARKERS)
    return False


def redact(value: Any, secrets_to_hide: list[str] | None = None, parent_key: str = "") -> Any:
    """Recursively redact secret-like keys and explicit secret values."""
    secrets = [secret for secret in (secrets_to_hide or []) if secret]
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            if SECRET_KEY_RE.search(key_text):
                redacted[key_text] = "[REDACTED]"
            elif key_text == "modules" and isinstance(item, dict):
                redacted[key_text] = summarize_modules(item)
            else:
                redacted[key_text] = redact(item, secrets, key_text)
        return redacted
    if isinstance(value, list):
        return [redact(item, secrets, parent_key) for item in value]
    if isinstance(value, str):
        text = value
        for secret in secrets:
            text = text.replace(secret, "[REDACTED]")
        if looks_like_code_leak(text, parent_key):
            return f"[REDACTED_CODE sizeBytes={len(value.encode('utf-8'))}]"
        return text
    return value


def assert_no_secret_or_code_leak(payload: Any, secrets_to_hide: list[str]) -> None:
    """Fail closed if evidence contains secrets or bundle contents."""
    encoded = json.dumps(payload, sort_keys=True)
    for secret in secrets_to_hide:
        if secret and secret in encoded:
            raise DeployError("evidence contains a secret value")
    if "module.exports" in encoded or "exports.loop" in encoded:
        raise DeployError("evidence contains uploaded code contents")


def api_payload_succeeded(result: HttpResult) -> bool:
    """Return whether a Screeps API payload looks successful."""
    if result.status < 200 or result.status >= 300:
        return False
    if not isinstance(result.payload, dict):
        return True
    ok_value = result.payload.get("ok")
    if "error" in result.payload and ok_value not in (1, True):
        return False
    return ok_value is None or ok_value is True or ok_value == 1


def require_api_success(name: str, result: HttpResult, secrets: list[str] | None = None) -> None:
    """Raise a sanitized error when an API request failed."""
    if not api_payload_succeeded(result):
        raise DeployError(f"{name} failed: HTTP {result.status}: {short_text(redact(result.payload, secrets), 500)}")


def upload_succeeded(result: HttpResult) -> bool:
    """Return whether ``POST /api/user/code`` accepted the bundle."""
    if not api_payload_succeeded(result):
        return False
    return isinstance(result.payload, dict) and (
        result.payload.get("ok") in (1, True) or "timestamp" in result.payload
    )


def short_text(value: Any, max_len: int) -> str:
    """Return bounded text for sanitized errors."""
    text = str(value)
    if len(text) <= max_len:
        return text
    return text[: max_len - 1] + "..."


def extract_branches(payload: Any) -> list[dict[str, Any]]:
    """Extract branch records from known Screeps branch-list shapes."""
    raw_list: Any
    if isinstance(payload, list):
        raw_list = payload
    elif isinstance(payload, dict):
        raw_list = payload.get("list", payload.get("branches", payload.get("data")))
        if raw_list is None:
            raw_list = [
                {"branch": key, **value}
                for key, value in payload.items()
                if isinstance(value, dict) and key not in {"ok", "error"}
            ]
    else:
        raw_list = []

    branches: list[dict[str, Any]] = []
    if not isinstance(raw_list, list):
        return branches
    for item in raw_list:
        if not isinstance(item, dict):
            continue
        name = item.get("branch", item.get("name"))
        if isinstance(name, str):
            branches.append({"name": name, **item})
    return branches


def find_branch(branches: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    """Find one branch record by normalized name."""
    for branch in branches:
        if branch.get("name") == name or branch.get("branch") == name:
            return branch
    return None


def active_world_branch_name(branches: list[dict[str, Any]]) -> str | None:
    """Return the current active World branch name from branch metadata."""
    for branch in branches:
        if bool(branch.get("activeWorld")):
            name = branch.get("name", branch.get("branch"))
            if isinstance(name, str):
                return name
    return None


def branch_evidence(branches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return branch names and safe active flags only."""
    return [
        {
            "name": branch.get("name", branch.get("branch")),
            "activeWorld": bool(branch.get("activeWorld")),
            "activeSim": bool(branch.get("activeSim")),
        }
        for branch in branches
    ]


def verify_remote_module(payload: Any, expected_sha256: str) -> dict[str, Any]:
    """Compare remote ``main`` module by hash without returning code."""
    modules = payload.get("modules") if isinstance(payload, dict) else None
    if not isinstance(modules, dict):
        return {"status": "missing-modules", "matched": False}
    main = modules.get("main")
    if not isinstance(main, str):
        return {"status": "missing-main-module", "matched": False}
    encoded = main.encode("utf-8")
    sha256 = hashlib.sha256(encoded).hexdigest()
    matched = sha256 == expected_sha256
    return {
        "status": "matched" if matched else "mismatch",
        "matched": matched,
        "remote": {
            "module": "main",
            "sizeBytes": len(encoded),
            "sha256": sha256,
        },
    }


def base_evidence(cfg: DeployConfig, artifact: dict[str, Any]) -> dict[str, Any]:
    """Build common deploy evidence fields."""
    return {
        "ok": False,
        "mode": "deploy" if cfg.deploy else "dry-run",
        "timestampUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "git": git_metadata(cfg.repo_root),
        "target": {
            "apiUrl": cfg.api_url,
            "branch": cfg.branch,
            "shard": cfg.shard,
            "room": cfg.room,
        },
        "artifact": artifact,
        "verification": {},
        "requests": [],
        "postDeployMonitoring": {
            "room": f"{cfg.shard}/{cfg.room}",
            "evidenceNeeded": [
                "deploy evidence JSON from this script",
                "runtime monitor summary/alert JSON for the target room",
                "runtime-summary console capture or explicit telemetry-silence finding",
            ],
        },
    }


def planned_requests(cfg: DeployConfig, artifact: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the dry-run request plan without making network calls."""
    requests = [
        {"method": "GET", "path": "/api/user/branches", "params": {}, "payload": {}},
        {
            "method": "POST",
            "path": "/api/user/clone-branch",
            "params": {},
            "payload": {"branch": cfg.clone_source_branch or "<activeWorld-or-default>", "newName": cfg.branch},
            "condition": "only when target branch is missing",
        },
        {
            "method": "POST",
            "path": "/api/user/code",
            "params": {},
            "payload": {"branch": cfg.branch, "modules": {"main": {"redacted": True, **artifact}}},
        },
        {"method": "GET", "path": "/api/user/code", "params": {"branch": cfg.branch}, "payload": {}},
    ]
    if cfg.activate_world:
        requests.extend(
            [
                {
                    "method": "POST",
                    "path": "/api/user/set-active-branch",
                    "params": {},
                    "payload": {"activeName": "activeWorld", "branch": cfg.branch},
                },
                {"method": "GET", "path": "/api/user/branches", "params": {}, "payload": {}},
                {"method": "GET", "path": "/api/user/code", "params": {"branch": "$activeWorld"}, "payload": {}},
            ]
        )
    return requests


def run_deploy(
    cfg: DeployConfig,
    env: dict[str, str] | None = None,
    transport: Callable[..., HttpResult] | None = None,
) -> dict[str, Any]:
    """Execute dry-run or deploy mode and return safe evidence."""
    if env is None:
        env = os.environ
    if cfg.deploy:
        require_https_api_url(cfg.api_url)
    artifact_bytes, artifact = read_artifact(cfg.artifact_path)
    evidence = base_evidence(cfg, artifact)
    if not cfg.deploy:
        evidence["ok"] = True
        evidence["verification"] = {
            "dryRun": {
                "status": "passed",
                "message": "artifact exists; no token read and no network writes attempted",
            }
        }
        evidence["requests"] = planned_requests(cfg, artifact)
        return evidence

    token = env.get(AUTH_TOKEN_ENV, "")
    if not token:
        raise DeployError(f"{AUTH_TOKEN_ENV} is required for --deploy")
    if cfg.confirm != cfg.expected_confirmation:
        raise DeployError(f'--confirm must exactly equal "{cfg.expected_confirmation}"')

    module = decode_module(artifact_bytes, cfg.artifact_path)
    client = ScreepsApi(cfg.api_url, token, cfg.timeout_seconds, transport)

    first_branches_result = client.list_branches()
    require_api_success("list branches", first_branches_result, [token])
    first_branches = extract_branches(first_branches_result.payload)
    target_exists_before = find_branch(first_branches, cfg.branch) is not None
    clone_source = cfg.clone_source_branch or active_world_branch_name(first_branches) or "default"
    branch_created = False

    if not target_exists_before:
        clone_result = client.clone_branch(clone_source, cfg.branch)
        require_api_success("clone branch", clone_result, [token])
        branch_created = True

    second_branches_result = client.list_branches()
    require_api_success("refresh branches", second_branches_result, [token])
    second_branches = extract_branches(second_branches_result.payload)

    upload_result = client.upload_code(cfg.branch, module)
    if not upload_succeeded(upload_result):
        raise DeployError(
            f"upload code failed: HTTP {upload_result.status}: {short_text(redact(upload_result.payload, [token]), 500)}"
        )

    branch_code_result = client.get_code(cfg.branch)
    require_api_success("verify branch code", branch_code_result, [token])
    branch_verify = verify_remote_module(branch_code_result.payload, artifact["sha256"])
    if not branch_verify["matched"]:
        raise DeployError("uploaded branch hash verification failed")

    final_branches = second_branches
    active_verify: dict[str, Any] = {"requested": cfg.activate_world, "status": "not-requested"}
    if cfg.activate_world:
        active_result = client.set_active_world_branch(cfg.branch)
        require_api_success("set activeWorld branch", active_result, [token])

        active_branches_result = client.list_branches()
        require_api_success("verify active branch metadata", active_branches_result, [token])
        final_branches = extract_branches(active_branches_result.payload)
        active_name = active_world_branch_name(final_branches)
        if active_name != cfg.branch:
            raise DeployError(f"activeWorld branch mismatch: expected {cfg.branch}, got {active_name or 'none'}")

        active_code_result = client.get_code("$activeWorld")
        require_api_success("verify activeWorld code", active_code_result, [token])
        active_code_verify = verify_remote_module(active_code_result.payload, artifact["sha256"])
        if not active_code_verify["matched"]:
            raise DeployError("activeWorld hash verification failed")
        active_verify = {
            "requested": True,
            "status": "matched",
            "activeWorldBranch": active_name,
            "code": active_code_verify,
        }

    evidence["ok"] = True
    evidence["requests"] = client.requests
    evidence["verification"] = {
        "branches": {
            "targetExistsBefore": target_exists_before,
            "targetCreated": branch_created,
            "cloneSourceBranch": clone_source if branch_created else None,
            "targetExistsAfter": find_branch(final_branches, cfg.branch) is not None,
            "activeWorldBranch": active_world_branch_name(final_branches),
            "observed": branch_evidence(final_branches),
        },
        "branchCode": branch_verify,
        "activeWorld": active_verify,
    }
    assert_no_secret_or_code_leak(evidence, [token, module])
    return evidence


def reason_triggers_auto_rollback(reason: Any) -> bool:
    """Return whether a health-gate reason authorizes rollback."""
    if not isinstance(reason, dict):
        return False
    kind = reason.get("kind")
    if isinstance(kind, str) and kind in ROLLBACK_TRIGGER_REASON_KINDS:
        return True
    source = reason.get("source")
    return reason_triggers_auto_rollback(source)


def health_gate_triggers_auto_rollback(health_gate: dict[str, Any]) -> bool:
    """Return whether a failed post-deploy health gate should roll back."""
    if health_gate.get("ok") is not False:
        return False
    reasons = health_gate.get("reasons")
    if not isinstance(reasons, list):
        return False
    return any(reason_triggers_auto_rollback(reason) for reason in reasons)


def read_json_object(path: Path) -> dict[str, Any]:
    """Read an object JSON file."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DeployError(f"could not read JSON evidence {path}: {short_text(exc, 200)}") from None
    if not isinstance(payload, dict):
        raise DeployError(f"expected object JSON evidence: {path}")
    return payload


def write_json_object(path: Path, payload: dict[str, Any]) -> None:
    """Write deterministic object JSON without printing it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def paired_health_gate_path(deploy_path: Path) -> Path:
    """Return the expected post-deploy health-gate evidence path."""
    stem = deploy_path.stem
    if stem == "official-screeps-deploy":
        return deploy_path.with_name("postdeploy-health-gate.json")
    prefix = "official-screeps-deploy-"
    if stem.startswith(prefix):
        return deploy_path.with_name(f"postdeploy-health-gate-{stem[len(prefix):]}.json")
    return deploy_path.with_name("postdeploy-health-gate.json")


def deploy_evidence_sort_key(path: Path, payload: dict[str, Any]) -> str:
    """Return a sortable key for deploy evidence recency."""
    timestamp = payload.get("timestampUtc")
    if isinstance(timestamp, str) and timestamp:
        return timestamp
    try:
        return f"{path.stat().st_mtime:020.6f}"
    except OSError:
        return ""


def iter_successful_deploy_evidence(evidence_dir: Path) -> list[PreviousDeployEvidence]:
    """Return deploy evidence records whose paired health gate passed."""
    if not evidence_dir.exists():
        return []
    records: list[PreviousDeployEvidence] = []
    for deploy_path in sorted(evidence_dir.glob("official-screeps-deploy*.json")):
        try:
            deploy_payload = read_json_object(deploy_path)
        except DeployError:
            continue
        if deploy_payload.get("ok") is not True or deploy_payload.get("mode") != "deploy":
            continue
        git_payload = deploy_payload.get("git")
        commit = git_payload.get("commit") if isinstance(git_payload, dict) else None
        if not isinstance(commit, str) or not commit or commit == "unknown":
            continue
        health_path = paired_health_gate_path(deploy_path)
        if not health_path.exists():
            continue
        try:
            health_payload = read_json_object(health_path)
        except DeployError:
            continue
        if health_payload.get("ok") is not True:
            continue
        records.append(
            PreviousDeployEvidence(
                commit=commit,
                deploy_path=deploy_path,
                health_gate_path=health_path,
                deploy=deploy_payload,
                health_gate=health_payload,
                sort_key=deploy_evidence_sort_key(deploy_path, deploy_payload),
            )
        )
    return records


def find_previous_healthy_deploy(
    evidence_dir: Path,
    *,
    current_commit: str | None = None,
    current_evidence_path: Path | None = None,
) -> PreviousDeployEvidence:
    """Find the most recent healthy deploy before the failed deploy."""
    current_path = current_evidence_path.resolve() if current_evidence_path else None
    candidates = sorted(iter_successful_deploy_evidence(evidence_dir), key=lambda item: item.sort_key)
    for candidate in reversed(candidates):
        if current_commit and candidate.commit == current_commit:
            continue
        if current_path is not None and candidate.deploy_path.resolve() == current_path:
            continue
        return candidate
    raise DeployError(f"no previous healthy deploy evidence found in {evidence_dir}")


def safe_path_for_repo(path: Path, repo_root: Path) -> str:
    """Return a repo-relative path when possible."""
    try:
        return str(path.resolve().relative_to(repo_root.resolve()))
    except ValueError:
        return str(path)


def run_checked_command(
    name: str,
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    allow_failure: bool = False,
    secrets: list[str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run a subprocess and raise a sanitized DeployError on failure."""
    try:
        result = runner(
            command,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            timeout=timeout_seconds,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise DeployError(f"{name} failed: {short_text(redact(str(exc), secrets), 300)}") from None
    if result.returncode != 0 and not allow_failure:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise DeployError(f"{name} failed: {short_text(redact(detail, secrets), 500)}")
    return result


def checkout_rollback_sources(
    repo_root: Path,
    commit: str,
    *,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> None:
    """Restore the production source and TypeScript build config from a commit."""
    run_checked_command(
        "checkout rollback sources",
        ["git", "checkout", commit, "--", *ROLLBACK_SOURCE_PATHS],
        cwd=repo_root,
        runner=runner,
        timeout_seconds=60,
    )


def rebuild_rollback_bundle(
    repo_root: Path,
    *,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> None:
    """Rebuild prod/dist/main.js from the restored rollback sources."""
    run_checked_command(
        "rebuild rollback bundle",
        ["npm", "run", "build"],
        cwd=repo_root / "prod",
        runner=runner,
        timeout_seconds=180,
    )


def monitor_env(base_env: dict[str, str] | None, cfg: DeployConfig) -> dict[str, str]:
    """Build a runtime-monitor environment without logging secrets."""
    merged = os.environ.copy()
    if base_env:
        merged.update(base_env)
    merged["SCREEPS_ALERT_DEBOUNCE_SECONDS"] = "0"
    merged["SCREEPS_MONITOR_STATE_FILE"] = str(cfg.evidence_dir / "postdeploy-monitor-state.json")
    merged.setdefault("SCREEPS_MONITOR_CACHE_DIR", str(cfg.repo_root / "runtime-artifacts" / "screeps-monitor" / "terrain-cache"))
    return merged


def run_monitor_json(
    cfg: DeployConfig,
    args: list[str],
    output_path: Path,
    *,
    env: dict[str, str] | None = None,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    allow_failure: bool = False,
) -> dict[str, Any]:
    """Run the runtime monitor and persist its JSON stdout."""
    script = cfg.repo_root / "scripts" / "screeps-runtime-monitor.py"
    result = run_checked_command(
        "runtime monitor",
        [sys.executable, str(script), *args],
        cwd=cfg.repo_root,
        env=monitor_env(env, cfg),
        runner=runner,
        timeout_seconds=DEFAULT_MONITOR_TIMEOUT_SECONDS,
        allow_failure=allow_failure,
        secrets=[(env or os.environ).get(AUTH_TOKEN_ENV, "")],
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(result.stdout, encoding="utf-8")
    payload = decode_json_body(result.stdout.encode("utf-8"))
    if not isinstance(payload, dict):
        raise DeployError(f"runtime monitor returned non-object JSON: {output_path}")
    if result.returncode != 0 and "ok" not in payload:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise DeployError(f"runtime monitor failed: {short_text(redact(detail, [(env or os.environ).get(AUTH_TOKEN_ENV, '')]), 500)}")
    return payload


def run_postdeploy_health_gate(
    cfg: DeployConfig,
    *,
    env: dict[str, str] | None = None,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> dict[str, Any]:
    """Capture post-deploy summary/alert evidence and evaluate the health gate."""
    cfg.evidence_dir.mkdir(parents=True, exist_ok=True)
    room = f"{cfg.shard}/{cfg.room}"
    out_dir = cfg.repo_root / "runtime-artifacts" / "screeps-monitor"
    summary_path = cfg.evidence_dir / "postdeploy-summary.json"
    alert_path = cfg.evidence_dir / "postdeploy-alert.json"
    health_path = cfg.evidence_dir / "postdeploy-health-gate.json"

    run_monitor_json(cfg, ["summary", "--room", room, "--out-dir", str(out_dir)], summary_path, env=env, runner=runner)
    run_monitor_json(
        cfg,
        ["alert", "--room", room, "--out-dir", str(out_dir), "--force-alert-image"],
        alert_path,
        env=env,
        runner=runner,
    )
    return run_monitor_json(
        cfg,
        ["health-gate", "--summary", str(summary_path), "--alert", str(alert_path)],
        health_path,
        env=env,
        runner=runner,
        allow_failure=True,
    )


def number_or_none(value: Any) -> float | None:
    """Return a numeric count, ignoring bools and non-numeric values."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def first_number(payload: dict[str, Any], keys: tuple[str, ...]) -> float | None:
    """Return the first numeric value for a set of possible field names."""
    for key in keys:
        value = number_or_none(payload.get(key))
        if value is not None:
            return value
    return None


def recovery_room_candidates(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract possible room summary objects from summary or alert JSON."""
    for key in ("room_summaries", "rooms"):
        value = payload.get(key)
        if isinstance(value, list):
            rooms = [item for item in value if isinstance(item, dict)]
            if rooms:
                return rooms
    if any(key in payload for key in ("owned_spawns", "owned_creeps", "spawns", "creeps")):
        return [payload]
    return []


def room_payload_matches(payload: dict[str, Any], shard: str, room: str) -> bool:
    """Return whether a room payload refers to the target room."""
    target = f"{shard}/{room}"
    for key in ("room", "key"):
        value = payload.get(key)
        if value == target or value == room:
            return True
    name = payload.get("name", payload.get("roomName"))
    payload_shard = payload.get("shard")
    return name == room and (payload_shard in (None, shard))


def recovery_status_from_payload(payload: dict[str, Any], shard: str, room: str) -> dict[str, Any]:
    """Return whether monitor JSON proves rollback recovery."""
    candidates = recovery_room_candidates(payload)
    matched = [candidate for candidate in candidates if room_payload_matches(candidate, shard, room)]
    if not matched and len(candidates) == 1:
        matched = candidates
    if not matched:
        return {"ok": False, "reason": "target room not found", "room": f"{shard}/{room}"}

    room_payload = matched[0]
    spawns = first_number(room_payload, ("owned_spawns", "ownedSpawnCount", "spawns", "spawnCount"))
    creeps = first_number(room_payload, ("owned_creeps", "ownedCreeps", "ownedCreepCount", "creeps", "creepCount"))
    recovered = spawns is not None and spawns >= 1 and creeps is not None and creeps >= 1
    return {
        "ok": recovered,
        "room": room_payload.get("room", f"{shard}/{room}"),
        "owned_spawns": spawns,
        "owned_creeps": creeps,
    }


def wait_for_room_recovery(
    shard: str,
    room: str,
    reader: Callable[[], dict[str, Any]],
    *,
    timeout_seconds: int,
    poll_seconds: int,
    sleeper: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """Poll monitor JSON until the target room has a spawn and owned creep."""
    deadline = monotonic() + timeout_seconds
    attempts = 0
    last_status: dict[str, Any] = {"ok": False, "reason": "not checked"}
    while True:
        attempts += 1
        last_status = recovery_status_from_payload(reader(), shard, room)
        last_status["attempts"] = attempts
        if last_status["ok"]:
            return last_status
        remaining = deadline - monotonic()
        if remaining <= 0:
            last_status["ok"] = False
            last_status.setdefault("reason", "recovery verification timed out")
            return last_status
        sleeper(min(float(poll_seconds), remaining))


def make_runtime_summary_reader(
    cfg: DeployConfig,
    *,
    env: dict[str, str] | None = None,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> Callable[[], dict[str, Any]]:
    """Build a reader that captures fresh runtime summary JSON for recovery."""
    room = f"{cfg.shard}/{cfg.room}"
    out_dir = cfg.repo_root / "runtime-artifacts" / "screeps-monitor"
    recovery_path = cfg.evidence_dir / "auto-rollback-recovery-summary.json"

    def read() -> dict[str, Any]:
        return run_monitor_json(cfg, ["summary", "--room", room, "--out-dir", str(out_dir)], recovery_path, env=env, runner=runner)

    return read


def github_repository(repo_root: Path, env: dict[str, str] | None = None) -> str | None:
    """Return owner/repo for GitHub issue creation when it can be inferred."""
    if env and env.get("GITHUB_REPOSITORY"):
        return env["GITHUB_REPOSITORY"]
    remote = git_output(repo_root, "config", "--get", "remote.origin.url")
    if remote == "unknown":
        return None
    match = re.search(r"github\.com[:/](?P<repo>[^/]+/[^/.]+)(?:\.git)?$", remote)
    return match.group("repo") if match else None


def github_commit_link(repo: str | None, commit: str | None) -> str:
    """Return a commit URL when repository metadata is available."""
    if not repo or not commit:
        return commit or "unknown"
    return f"https://github.com/{repo}/commit/{commit}"


def create_github_issue(
    title: str,
    body: str,
    labels: list[str],
    repo_root: Path,
) -> dict[str, Any]:
    """Create a GitHub issue through gh and return safe metadata."""
    repo = github_repository(repo_root, os.environ)
    command = ["gh", "issue", "create", "--title", title, "--body", body]
    for label in labels:
        command.extend(["--label", label])
    if repo:
        command.extend(["--repo", repo])
    result = run_checked_command(
        "create GitHub rollback issue",
        command,
        cwd=repo_root,
        timeout_seconds=30,
        secrets=[os.environ.get("GITHUB_TOKEN", ""), os.environ.get("GH_TOKEN", "")],
    )
    url = result.stdout.strip().splitlines()[-1] if result.stdout.strip() else ""
    return {"created": True, "url": url, "title": title, "labels": labels}


def build_auto_rollback_issue_body(cfg: DeployConfig, summary: dict[str, Any]) -> str:
    """Build a concise P0 incident body for a successful auto-rollback."""
    repo = github_repository(cfg.repo_root, os.environ)
    failed_commit = str(summary.get("failedCommit", "unknown"))
    rollback_commit = str(summary.get("rollbackCommit", "unknown"))
    reason_kinds = ", ".join(summary.get("triggerReasonKinds", [])) or "unknown"
    return "\n".join(
        [
            "Auto-rollback deployed after the official post-deploy health gate reported a room survival failure.",
            "",
            f"- Target: {cfg.shard}/{cfg.room}",
            f"- Trigger reasons: {reason_kinds}",
            f"- Failed commit: {github_commit_link(repo, failed_commit)}",
            f"- Rollback commit: {github_commit_link(repo, rollback_commit)}",
            f"- Failed deploy evidence: {summary.get('failedDeployEvidencePath', 'unknown')}",
            f"- Failed health gate evidence: {summary.get('failedHealthGateEvidencePath', 'unknown')}",
            f"- Previous deploy evidence: {summary.get('previousDeployEvidencePath', 'unknown')}",
            f"- Previous health gate evidence: {summary.get('previousHealthGateEvidencePath', 'unknown')}",
            f"- Rollback deploy evidence: {summary.get('rollbackDeployEvidencePath', 'unknown')}",
            f"- Recovery: spawn={summary.get('recovery', {}).get('owned_spawns')} creeps={summary.get('recovery', {}).get('owned_creeps')}",
        ]
    )


def trigger_reason_kinds(health_gate: dict[str, Any]) -> list[str]:
    """Return matched rollback trigger kinds from a health-gate result."""
    kinds: list[str] = []
    reasons = health_gate.get("reasons")
    if not isinstance(reasons, list):
        return kinds
    for reason in reasons:
        if not isinstance(reason, dict):
            continue
        stack = [reason]
        while stack:
            item = stack.pop()
            kind = item.get("kind")
            if isinstance(kind, str) and kind in ROLLBACK_TRIGGER_REASON_KINDS:
                kinds.append(kind)
            source = item.get("source")
            if isinstance(source, dict):
                stack.append(source)
    return sorted(set(kinds))


def auto_rollback_escalation_message(reason: str) -> str:
    """Format the mandatory rollback failure escalation."""
    return f"AUTO-ROLLBACK ESCALATION: rollback failed; manual intervention required. Reason: {reason}"


def execute_auto_rollback(
    cfg: DeployConfig,
    failed_deploy_evidence: dict[str, Any],
    failed_health_gate: dict[str, Any],
    *,
    env: dict[str, str] | None = None,
    transport: Callable[..., HttpResult] | None = None,
    command_runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    recovery_reader: Callable[[], dict[str, Any]] | None = None,
    issue_creator: Callable[[str, str, list[str], Path], dict[str, Any]] = create_github_issue,
    sleeper: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """Deploy the last-known-healthy bundle and verify room recovery."""
    try:
        git_payload = failed_deploy_evidence.get("git")
        failed_commit = git_payload.get("commit") if isinstance(git_payload, dict) else None
        previous = find_previous_healthy_deploy(
            cfg.evidence_dir,
            current_commit=failed_commit if isinstance(failed_commit, str) else None,
            current_evidence_path=cfg.evidence_path,
        )

        checkout_rollback_sources(cfg.repo_root, previous.commit, runner=command_runner)
        rebuild_rollback_bundle(cfg.repo_root, runner=command_runner)

        rollback_deploy_path = cfg.evidence_dir / "auto-rollback-deploy.json"
        rollback_cfg = replace(
            cfg,
            artifact_path=cfg.repo_root / "prod" / "dist" / "main.js",
            evidence_path=rollback_deploy_path,
            auto_rollback=False,
        )
        rollback_evidence = run_deploy(rollback_cfg, env=env, transport=transport)
        write_json_object(rollback_deploy_path, rollback_evidence)

        reader = recovery_reader or make_runtime_summary_reader(cfg, env=env, runner=command_runner)
        recovery = wait_for_room_recovery(
            cfg.shard,
            cfg.room,
            reader,
            timeout_seconds=cfg.rollback_recovery_timeout_seconds,
            poll_seconds=cfg.rollback_recovery_poll_seconds,
            sleeper=sleeper,
            monotonic=monotonic,
        )
        if recovery.get("ok") is not True:
            raise DeployError(f"recovery verification failed: {short_text(recovery, 500)}")

        summary: dict[str, Any] = {
            "ok": True,
            "target": f"{cfg.shard}/{cfg.room}",
            "failedCommit": failed_commit or "unknown",
            "rollbackCommit": previous.commit,
            "triggerReasonKinds": trigger_reason_kinds(failed_health_gate),
            "failedDeployEvidencePath": safe_path_for_repo(cfg.evidence_path, cfg.repo_root) if cfg.evidence_path else None,
            "failedHealthGateEvidencePath": safe_path_for_repo(cfg.evidence_dir / "postdeploy-health-gate.json", cfg.repo_root),
            "previousDeployEvidencePath": safe_path_for_repo(previous.deploy_path, cfg.repo_root),
            "previousHealthGateEvidencePath": safe_path_for_repo(previous.health_gate_path, cfg.repo_root),
            "rollbackDeployEvidencePath": safe_path_for_repo(rollback_deploy_path, cfg.repo_root),
            "recovery": recovery,
        }
        issue_body = build_auto_rollback_issue_body(cfg, summary)
        summary["githubIssue"] = issue_creator(ROLLBACK_ISSUE_TITLE, issue_body, ["priority:p0"], cfg.repo_root)
        write_json_object(cfg.evidence_dir / "auto-rollback-summary.json", summary)
        return summary
    except DeployError as exc:
        message = str(exc)
        if message.startswith("AUTO-ROLLBACK ESCALATION:"):
            raise
        raise DeployError(auto_rollback_escalation_message(message)) from None


def http_json(
    method: str,
    base_url: str,
    path: str,
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    timeout: int = DEFAULT_TIMEOUT_SECONDS,
) -> HttpResult:
    """Send a JSON HTTP request to the Screeps API."""
    url = base_url.rstrip("/") + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    request_headers = {"Accept": "application/json", "User-Agent": "screeps-official-deploy/1.0"}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    if headers:
        request_headers.update(headers)

    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return HttpResult(response.status, decode_json_body(response.read()), dict(response.headers.items()))
    except urllib.error.HTTPError as exc:
        return HttpResult(exc.code, decode_json_body(exc.read()), dict(exc.headers.items()))
    except urllib.error.URLError as exc:
        raise DeployError(f"request failed: {short_text(exc.reason, 300)}") from exc


def decode_json_body(raw: bytes) -> Any:
    """Decode a JSON response body with a bounded fallback."""
    text = raw.decode("utf-8", errors="replace")
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"error": short_text(text, 500)}


def write_evidence(evidence: dict[str, Any], path: Path | None) -> None:
    """Write evidence JSON to stdout and optionally a file."""
    rendered = json.dumps(evidence, indent=2, sort_keys=True)
    if path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


def build_parser() -> argparse.ArgumentParser:
    """Build the CLI parser."""
    parser = argparse.ArgumentParser(description="Deploy prod/dist/main.js to the official Screeps API safely.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Verify artifact metadata only; default when --deploy is omitted.")
    mode.add_argument("--deploy", action="store_true", help="Perform authenticated API writes.")
    parser.add_argument("--activate-world", action="store_true", help="Set the deployed branch as activeWorld and verify it by hash.")
    parser.add_argument("--confirm", help='Required for --deploy, e.g. "deploy main to shardX/E26S49".')
    parser.add_argument("--api-url", default=os.environ.get("SCREEPS_API_URL", DEFAULT_API_URL))
    parser.add_argument("--branch", default=os.environ.get("SCREEPS_BRANCH", DEFAULT_BRANCH))
    parser.add_argument("--shard", default=os.environ.get("SCREEPS_SHARD", DEFAULT_SHARD))
    parser.add_argument("--room", default=os.environ.get("SCREEPS_ROOM", DEFAULT_ROOM))
    parser.add_argument("--artifact", type=Path, default=Path(os.environ.get("SCREEPS_ARTIFACT_PATH", DEFAULT_ARTIFACT_PATH)))
    parser.add_argument("--clone-source-branch", default=os.environ.get("SCREEPS_CLONE_SOURCE_BRANCH"))
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--evidence-path", type=Path)
    parser.add_argument("--evidence-dir", type=Path, default=Path(os.environ.get("SCREEPS_DEPLOY_EVIDENCE_DIR", DEFAULT_EVIDENCE_DIR)))
    parser.add_argument(
        "--auto-rollback",
        action="store_true",
        help="After deploy, run the post-deploy health gate and roll back on room_dead/no_owned_spawn failures.",
    )
    parser.add_argument(
        "--rollback-recovery-timeout-seconds",
        type=int,
        default=DEFAULT_ROLLBACK_RECOVERY_TIMEOUT_SECONDS,
        help="Maximum seconds to wait for post-rollback spawn/creep recovery.",
    )
    return parser


def config_from_args(args: argparse.Namespace) -> DeployConfig:
    """Create a validated deploy config from CLI arguments."""
    api_url = normalize_api_url(args.api_url)
    if args.deploy:
        require_https_api_url(api_url)
    branch = validate_selector("SCREEPS_BRANCH", args.branch, BRANCH_RE)
    shard = validate_selector("SCREEPS_SHARD", args.shard, SHARD_RE)
    room = validate_selector("SCREEPS_ROOM", args.room, ROOM_RE)
    clone_source = args.clone_source_branch
    if clone_source:
        clone_source = validate_selector("SCREEPS_CLONE_SOURCE_BRANCH", clone_source, BRANCH_RE)
    if args.timeout_seconds <= 0:
        raise DeployError("--timeout-seconds must be positive")
    if args.rollback_recovery_timeout_seconds <= 0:
        raise DeployError("--rollback-recovery-timeout-seconds must be positive")
    return DeployConfig(
        api_url=api_url,
        branch=branch,
        shard=shard,
        room=room,
        artifact_path=args.artifact,
        deploy=bool(args.deploy),
        activate_world=bool(args.activate_world),
        confirm=args.confirm,
        clone_source_branch=clone_source,
        timeout_seconds=args.timeout_seconds,
        evidence_path=args.evidence_path,
        evidence_dir=args.evidence_dir,
        auto_rollback=bool(args.auto_rollback),
        rollback_recovery_timeout_seconds=args.rollback_recovery_timeout_seconds,
    )


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint."""
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        cfg = config_from_args(args)
        evidence = run_deploy(cfg)
        write_evidence(evidence, cfg.evidence_path)
        if cfg.deploy and cfg.auto_rollback:
            health_gate = run_postdeploy_health_gate(cfg)
            if health_gate.get("ok") is True:
                return 0
            if not health_gate_triggers_auto_rollback(health_gate):
                raise DeployError(
                    f"post-deploy health gate failed without auto-rollback trigger: {short_text(health_gate, 500)}"
                )
            summary = execute_auto_rollback(cfg, evidence, health_gate)
            print(json.dumps({"ok": True, "autoRollback": summary}, indent=2, sort_keys=True))
        return 0
    except DeployError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
