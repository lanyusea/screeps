#!/usr/bin/env python3
"""Load selected local secret env values without logging their contents."""

from __future__ import annotations

import os
import re
import shlex
from pathlib import Path
from typing import Mapping, MutableMapping


DEFAULT_LOCAL_SECRET_ENV_FILE = Path("/root/.secret/.env")


def ensure_env_value_from_file(
    name: str,
    *,
    env_file: Path | None = None,
    override_env_var: str | None = None,
    default_env_file: Path = DEFAULT_LOCAL_SECRET_ENV_FILE,
    environ: MutableMapping[str, str] | None = None,
) -> bool:
    """Set one env value from an env file only when the current value is absent or blank."""
    env = environ if environ is not None else os.environ
    existing = env.get(name)
    if existing is not None and existing.strip():
        return False
    path = resolve_env_file(
        env_file=env_file,
        override_env_var=override_env_var,
        default_env_file=default_env_file,
        environ=env,
    )
    value = read_env_value_from_file(path, name)
    if not value:
        return False
    env[name] = value
    return True


def resolve_env_file(
    *,
    env_file: Path | None = None,
    override_env_var: str | None = None,
    default_env_file: Path = DEFAULT_LOCAL_SECRET_ENV_FILE,
    environ: Mapping[str, str] | None = None,
) -> Path:
    env = environ if environ is not None else os.environ
    if env_file is not None:
        return env_file.expanduser()
    if override_env_var:
        configured = env.get(override_env_var)
        if configured:
            return Path(configured).expanduser()
    return default_env_file.expanduser()


def read_env_value_from_file(path: Path, name: str) -> str | None:
    values = read_env_values_from_file(path, {name})
    value = values.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def read_env_values_from_file(path: Path, names: set[str] | None = None) -> dict[str, str]:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as error:
        reason = getattr(error, "strerror", None) or error.__class__.__name__
        raise RuntimeError(f"could not read secret env file {path}: {reason}") from error

    values: dict[str, str] = {}
    for line in text.splitlines():
        parsed = parse_env_assignment_line(line)
        if parsed is None:
            continue
        key, value = parsed
        if names is None or key in names:
            values[key] = value
    return values


def parse_env_assignment_line(line: str) -> tuple[str, str] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    export_match = re.match(r"export\s+", stripped)
    if export_match:
        stripped = stripped[export_match.end() :].lstrip()
    match = re.match(r"([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\Z", stripped)
    if not match:
        return None
    return match.group(1), parse_env_assignment_value(match.group(2).strip())


def parse_env_assignment_value(raw: str) -> str:
    uncommented = strip_unquoted_env_comment(raw).strip()
    if not uncommented:
        return ""
    if uncommented[0] not in {"'", '"'}:
        return uncommented
    try:
        parsed = shlex.split(uncommented, comments=False, posix=True)
    except ValueError:
        return uncommented
    return parsed[0] if parsed else ""


def strip_unquoted_env_comment(raw: str) -> str:
    quote: str | None = None
    escaped = False
    for index, char in enumerate(raw):
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in {"'", '"'}:
            quote = char
            continue
        if char == "#" and (index == 0 or raw[index - 1].isspace()):
            return raw[:index]
    return raw
