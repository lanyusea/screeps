#!/usr/bin/env python3
"""Small stdout/stderr helpers for cron-safe Python CLIs."""

from __future__ import annotations

import json
import os
from typing import Any, TextIO


DEFAULT_MAX_JSON_LINE_BYTES = 4096


def canonical_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


def compact_json_line(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":")) + "\n"


def bounded_json_line(value: dict[str, Any], *, max_bytes: int = DEFAULT_MAX_JSON_LINE_BYTES) -> str:
    """Return one compact JSON line, preserving key routing fields when truncated."""
    line = compact_json_line(value)
    if len(line.encode("utf-8")) <= max_bytes:
        return line

    bounded = {
        "ok": value.get("ok"),
        "artifact": value.get("artifact"),
        "artifactDir": value.get("artifactDir"),
        "report": value.get("report"),
        "runId": value.get("runId"),
        "status": value.get("status"),
        "type": value.get("type"),
        "truncated": True,
    }
    bounded = {key: item for key, item in bounded.items() if item is not None}
    line = compact_json_line(bounded)
    encoded = line.encode("utf-8")
    if len(encoded) <= max_bytes:
        return line

    fallback = {
        "ok": value.get("ok"),
        "status": value.get("status", "unknown"),
        "truncated": True,
    }
    line = compact_json_line(fallback)
    encoded = line.encode("utf-8")
    if len(encoded) <= max_bytes:
        return line
    return encoded[: max(0, max_bytes - 1)].decode("utf-8", errors="ignore") + "\n"


def write_text(stream: TextIO, text: str) -> bool:
    """Write text unless the receiver has already closed the pipe."""
    try:
        stream.write(text)
        stream.flush()
        return True
    except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
        try:
            with open(os.devnull, "w", encoding="utf-8") as devnull:
                os.dup2(devnull.fileno(), stream.fileno())
        except (OSError, AttributeError, ValueError):
            pass
        return False


def write_json(stream: TextIO, value: Any) -> bool:
    return write_text(stream, canonical_json(value))


def write_json_line(
    stream: TextIO,
    value: dict[str, Any],
    *,
    max_bytes: int = DEFAULT_MAX_JSON_LINE_BYTES,
) -> bool:
    return write_text(stream, bounded_json_line(value, max_bytes=max_bytes))
