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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ARTIFACT_PATH = REPO_ROOT / "prod" / "dist" / "main.js"
DEFAULT_API_URL = "https://screeps.com"
DEFAULT_BRANCH = "main"
DEFAULT_SHARD = "shardX"
DEFAULT_ROOM = "E48S28"
DEFAULT_TIMEOUT_SECONDS = 30
AUTH_TOKEN_ENV = "SCREEPS_AUTH_TOKEN"
SECRET_KEY_RE = re.compile(r"(authorization|password|secret|steam[_-]?key|token|x[_-]?token|x[_-]?username)", re.I)
BRANCH_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
SHARD_RE = re.compile(r"^[A-Za-z0-9_-]+$")
ROOM_RE = re.compile(r"^[WE]\d+[NS]\d+$")


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
    """Normalize and validate a safe HTTP API base URL."""
    parsed = urllib.parse.urlparse(raw_url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise DeployError("SCREEPS_API_URL must be an http(s) URL")
    if parsed.username or parsed.password:
        raise DeployError("SCREEPS_API_URL must not include credentials")
    if parsed.query or parsed.fragment:
        raise DeployError("SCREEPS_API_URL must not include query strings or fragments")
    path = parsed.path.rstrip("/")
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))


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
        if parent_key == "main" and (len(text) > 120 or "module.exports" in text):
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
    parser.add_argument("--confirm", help='Required for --deploy, e.g. "deploy main to shardX/E48S28".')
    parser.add_argument("--api-url", default=os.environ.get("SCREEPS_API_URL", DEFAULT_API_URL))
    parser.add_argument("--branch", default=os.environ.get("SCREEPS_BRANCH", DEFAULT_BRANCH))
    parser.add_argument("--shard", default=os.environ.get("SCREEPS_SHARD", DEFAULT_SHARD))
    parser.add_argument("--room", default=os.environ.get("SCREEPS_ROOM", DEFAULT_ROOM))
    parser.add_argument("--artifact", type=Path, default=Path(os.environ.get("SCREEPS_ARTIFACT_PATH", DEFAULT_ARTIFACT_PATH)))
    parser.add_argument("--clone-source-branch", default=os.environ.get("SCREEPS_CLONE_SOURCE_BRANCH"))
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--evidence-path", type=Path)
    return parser


def config_from_args(args: argparse.Namespace) -> DeployConfig:
    """Create a validated deploy config from CLI arguments."""
    api_url = normalize_api_url(args.api_url)
    branch = validate_selector("SCREEPS_BRANCH", args.branch, BRANCH_RE)
    shard = validate_selector("SCREEPS_SHARD", args.shard, SHARD_RE)
    room = validate_selector("SCREEPS_ROOM", args.room, ROOM_RE)
    clone_source = args.clone_source_branch
    if clone_source:
        clone_source = validate_selector("SCREEPS_CLONE_SOURCE_BRANCH", clone_source, BRANCH_RE)
    if args.timeout_seconds <= 0:
        raise DeployError("--timeout-seconds must be positive")
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
    )


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint."""
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        cfg = config_from_args(args)
        evidence = run_deploy(cfg)
        write_evidence(evidence, cfg.evidence_path)
        return 0
    except DeployError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
