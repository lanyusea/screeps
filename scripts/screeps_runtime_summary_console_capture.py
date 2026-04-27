#!/usr/bin/env python3
"""Persist Screeps #runtime-summary console lines into local artifacts."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, TextIO

import screeps_runtime_kpi_reducer as reducer


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT_DIR = REPO_ROOT / "runtime-artifacts" / "runtime-summary-console"
OUT_DIR_ENV = "SCREEPS_RUNTIME_SUMMARY_CONSOLE_OUT_DIR"
OUT_FILE_ENV = "SCREEPS_RUNTIME_SUMMARY_CONSOLE_OUT_FILE"
SAFE_ARTIFACT_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


@dataclass(frozen=True)
class PersistResult:
    input_paths: list[str]
    input_line_count: int
    persisted_line_count: int
    skipped_line_count: int
    output_path: Path | None

    def metadata(self) -> dict[str, object]:
        return {
            "inputPaths": self.input_paths,
            "inputLineCount": self.input_line_count,
            "persistedLineCount": self.persisted_line_count,
            "skippedLineCount": self.skipped_line_count,
            "outputPath": str(self.output_path) if self.output_path is not None else None,
        }


def iter_runtime_summary_lines(lines: Iterable[str]) -> Iterable[str]:
    for line in lines:
        normalized = normalize_runtime_summary_line(line)
        if normalized is not None:
            yield normalized


def normalize_runtime_summary_line(line: str) -> str | None:
    if not line.startswith(reducer.RUNTIME_SUMMARY_PREFIX):
        return None
    return line.rstrip("\r\n") + "\n"


def iter_input_lines(input_paths: list[str], stdin: TextIO = sys.stdin) -> Iterable[str]:
    paths = input_paths or ["-"]
    for path_text in paths:
        if path_text == "-":
            yield from stdin
            continue

        with Path(path_text).expanduser().open("r", encoding="utf-8") as input_file:
            yield from input_file


def default_artifact_name(now: datetime | None = None) -> str:
    timestamp = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return f"runtime-summary-console-{timestamp.strftime('%Y%m%dT%H%M%SZ')}.log"


def validate_artifact_name(name: str) -> str:
    if Path(name).name != name or not name or name in {".", ".."}:
        raise ValueError("--artifact-name must be a file name, not a path")
    if not SAFE_ARTIFACT_NAME_RE.fullmatch(name):
        raise ValueError("--artifact-name may contain only letters, numbers, dot, underscore, and hyphen")
    return name


def unique_artifact_path(path: Path) -> Path:
    if not path.exists():
        return path

    for index in range(2, 1000):
        candidate = path.with_name(f"{path.stem}-{index}{path.suffix}")
        if not candidate.exists():
            return candidate

    raise FileExistsError(f"could not choose a unique artifact path for {path}")


def resolve_output_path(
    out_dir: Path,
    out_file: Path | None = None,
    artifact_name: str | None = None,
    now: datetime | None = None,
) -> Path:
    if out_file is not None:
        return out_file.expanduser()

    name = validate_artifact_name(artifact_name or default_artifact_name(now))
    return unique_artifact_path(out_dir.expanduser() / name)


def write_artifact(path: Path, lines: list[str]) -> None:
    if path.exists():
        raise FileExistsError(f"artifact already exists: {path}")

    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = unique_artifact_path(path.with_name(f".{path.name}.tmp"))
    try:
        with temp_path.open("x", encoding="utf-8") as output:
            output.writelines(lines)
        temp_path.replace(path)
    except BaseException:
        try:
            temp_path.unlink()
        except OSError:
            pass
        raise


def persist_runtime_summary_artifact(
    input_paths: list[str],
    out_dir: Path = DEFAULT_OUT_DIR,
    out_file: Path | None = None,
    artifact_name: str | None = None,
    stdin: TextIO = sys.stdin,
    now: datetime | None = None,
) -> PersistResult:
    paths = input_paths or ["-"]
    input_line_count = 0
    persisted_lines: list[str] = []

    for line in iter_input_lines(input_paths, stdin=stdin):
        input_line_count += 1
        normalized = normalize_runtime_summary_line(line)
        if normalized is not None:
            persisted_lines.append(normalized)

    skipped_line_count = input_line_count - len(persisted_lines)
    if not persisted_lines:
        return PersistResult(
            input_paths=paths,
            input_line_count=input_line_count,
            persisted_line_count=0,
            skipped_line_count=skipped_line_count,
            output_path=None,
        )

    output_path = resolve_output_path(out_dir=out_dir, out_file=out_file, artifact_name=artifact_name, now=now)
    write_artifact(output_path, persisted_lines)

    return PersistResult(
        input_paths=paths,
        input_line_count=input_line_count,
        persisted_line_count=len(persisted_lines),
        skipped_line_count=skipped_line_count,
        output_path=output_path,
    )


def render_json(result: PersistResult) -> str:
    return json.dumps(result.metadata(), indent=2, sort_keys=True)


def render_human(result: PersistResult) -> str:
    output = str(result.output_path) if result.output_path is not None else "none"
    return (
        f"input lines: {result.input_line_count}; persisted: {result.persisted_line_count}; "
        f"skipped: {result.skipped_line_count}; output: {output}"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Persist only exact-prefix Screeps #runtime-summary console lines into a local artifact "
            "that the KPI artifact bridge can scan."
        ),
    )
    parser.add_argument(
        "inputs",
        nargs="*",
        help="Console log files to scan. Use '-' for stdin. Reads stdin when no inputs are provided.",
    )
    parser.add_argument(
        "--out-dir",
        default=os.environ.get(OUT_DIR_ENV, str(DEFAULT_OUT_DIR)),
        help=f"Artifact directory. Default: ${OUT_DIR_ENV} or {DEFAULT_OUT_DIR}.",
    )
    parser.add_argument(
        "--out-file",
        default=os.environ.get(OUT_FILE_ENV),
        help=f"Exact artifact file path. Overrides --out-dir and --artifact-name. May also be set with ${OUT_FILE_ENV}.",
    )
    parser.add_argument(
        "--artifact-name",
        help="Artifact file name to create inside --out-dir. Defaults to a UTC timestamped .log name.",
    )
    parser.add_argument(
        "--format",
        choices=("json", "human"),
        default="json",
        help="Output format. JSON is deterministic and is the default.",
    )
    return parser


def main(argv: list[str] | None = None, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> int:
    args = build_parser().parse_args(argv)
    result = persist_runtime_summary_artifact(
        input_paths=args.inputs,
        out_dir=Path(args.out_dir),
        out_file=Path(args.out_file) if args.out_file else None,
        artifact_name=args.artifact_name,
        stdin=stdin,
    )
    output = render_human(result) if args.format == "human" else render_json(result)
    stdout.write(output)
    stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
