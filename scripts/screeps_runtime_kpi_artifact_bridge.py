#!/usr/bin/env python3
"""Feed persisted Screeps runtime-summary artifacts into the KPI reducer."""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence, TextIO

import screeps_runtime_kpi_reducer as reducer


DEFAULT_INPUT_PATHS = (
    "/root/screeps/runtime-artifacts",
    "/root/.hermes/cron/output",
)
DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024

JsonObject = dict[str, Any]


@dataclass
class ScanResult:
    input_paths: list[str]
    lines: list[str] = field(default_factory=list)
    scanned_files: int = 0
    matched_files: int = 0
    skipped_files: list[JsonObject] = field(default_factory=list)

    def skip(self, path: Path | str, reason: str, **details: Any) -> None:
        entry: JsonObject = {"path": str(path), "reason": reason}
        entry.update(details)
        self.skipped_files.append(entry)

    def metadata(self) -> JsonObject:
        return {
            "inputPaths": self.input_paths,
            "matchedFiles": self.matched_files,
            "runtimeSummaryLines": len(self.lines),
            "scannedFiles": self.scanned_files,
            "skippedFileCount": len(self.skipped_files),
            "skippedFiles": self.skipped_files,
        }


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error

    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def collect_runtime_summary_lines(paths: Sequence[str], max_file_bytes: int = DEFAULT_MAX_FILE_BYTES) -> ScanResult:
    input_paths = list(paths) if paths else list(DEFAULT_INPUT_PATHS)
    result = ScanResult(input_paths=input_paths)

    for path_text in input_paths:
        path = Path(path_text).expanduser()
        if not path.exists():
            result.skip(path, "missing")
            continue

        if path.is_file():
            scan_file(path, result, max_file_bytes)
            continue

        if path.is_dir():
            for file_path in iter_directory_files(path, result):
                scan_file(file_path, result, max_file_bytes)
            continue

        result.skip(path, "not_file_or_directory")

    return result


def iter_directory_files(root: Path, result: ScanResult) -> list[Path]:
    files: list[Path] = []

    def record_error(error: OSError) -> None:
        result.skip(error.filename or root, "read_error")

    for dirpath, dirnames, filenames in os.walk(root, topdown=True, onerror=record_error, followlinks=False):
        dirnames[:] = sorted(dirnames)
        directory = Path(dirpath)
        for filename in sorted(filenames):
            files.append(directory / filename)

    return sorted(files, key=lambda path: str(path))


def scan_file(path: Path, result: ScanResult, max_file_bytes: int) -> None:
    if path.is_symlink():
        result.skip(path, "symlink")
        return

    try:
        stat_result = path.stat()
    except OSError:
        result.skip(path, "read_error")
        return

    if not path.is_file():
        result.skip(path, "not_regular_file")
        return

    result.scanned_files += 1
    if stat_result.st_size > max_file_bytes:
        result.skip(path, "oversized", sizeBytes=stat_result.st_size, maxFileBytes=max_file_bytes)
        return

    try:
        data = path.read_bytes()
    except OSError:
        result.skip(path, "read_error")
        return

    if b"\0" in data:
        result.skip(path, "binary")
        return

    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        result.skip(path, "binary")
        return

    matching_lines = [
        line if line.endswith("\n") else f"{line}\n"
        for line in text.splitlines()
        if reducer.RUNTIME_SUMMARY_PREFIX in line
    ]
    if not matching_lines:
        return

    result.matched_files += 1
    result.lines.extend(matching_lines)


def build_bridge_report(paths: Sequence[str], max_file_bytes: int = DEFAULT_MAX_FILE_BYTES) -> JsonObject:
    scan_result = collect_runtime_summary_lines(paths, max_file_bytes)
    report = reducer.reduce_runtime_kpis(scan_result.lines)
    report["source"] = scan_result.metadata()
    return report


def render_human(report: JsonObject) -> str:
    source = report["source"]
    source_line = (
        f"source: scanned {source['scannedFiles']} file(s), matched {source['matchedFiles']}, "
        f"runtime-summary lines {source['runtimeSummaryLines']}, skipped {source['skippedFileCount']}"
    )
    return "\n".join([source_line, reducer.render_human(report)])


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Scan persisted local artifacts for #runtime-summary lines and reduce them into KPI evidence.",
    )
    parser.add_argument(
        "paths",
        nargs="*",
        help=(
            "Files or directories to scan. Defaults to /root/screeps/runtime-artifacts "
            "and /root/.hermes/cron/output when omitted."
        ),
    )
    parser.add_argument(
        "--format",
        choices=("json", "human"),
        default="json",
        help="Output format. JSON is deterministic and is the default.",
    )
    parser.add_argument(
        "--max-file-bytes",
        type=positive_int,
        default=DEFAULT_MAX_FILE_BYTES,
        help=f"Skip files larger than this many bytes. Default: {DEFAULT_MAX_FILE_BYTES}.",
    )
    return parser


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout) -> int:
    args = build_parser().parse_args(argv)
    report = build_bridge_report(args.paths, max_file_bytes=args.max_file_bytes)
    output = render_human(report) if args.format == "human" else reducer.render_json(report)
    stdout.write(output)
    stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
