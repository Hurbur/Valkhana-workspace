#!/usr/bin/env python3
"""Guarded Hermes compatibility probe for the ValKhana promotion gate."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

OUTPUT_LIMIT = 256 * 1024
COMMAND_TIMEOUT = 30
CANARY_BOARD_PREFIXES = ("valkhana-canary-", "valkhana-candidate")
VERSION_PATTERN = re.compile(r"^Hermes Agent v(\d+)\.(\d+)\.(\d+)\b")


class CanaryError(RuntimeError):
    pass


def run(cli: Path, *arguments: str, timeout: int = COMMAND_TIMEOUT) -> str:
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        process = subprocess.Popen(
            [str(cli), *arguments],
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            close_fds=True,
        )
        try:
            status = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise CanaryError(f"Hermes command timed out: {' '.join(arguments)}") from None

        stdout_size = stdout.tell()
        stderr_size = stderr.tell()
        if stdout_size > OUTPUT_LIMIT or stderr_size > OUTPUT_LIMIT:
            raise CanaryError(f"Hermes command exceeded {OUTPUT_LIMIT} bytes")
        stdout.seek(0)
        stderr.seek(0)
        output = stdout.read().decode("utf-8", errors="strict")
        error = stderr.read().decode("utf-8", errors="replace").strip()
        if status != 0:
            detail = error.splitlines()[0] if error else f"exit {status}"
            raise CanaryError(f"Hermes command failed ({' '.join(arguments)}): {detail}")
        return output


def run_json(cli: Path, *arguments: str, timeout: int = COMMAND_TIMEOUT) -> Any:
    try:
        return json.loads(run(cli, *arguments, timeout=timeout))
    except json.JSONDecodeError as error:
        raise CanaryError(f"Hermes returned invalid JSON for {' '.join(arguments)}") from error


def task_status(cli: Path, board: str, task_id: str) -> str:
    payload = run_json(cli, "kanban", "--board", board, "show", task_id, "--json")
    return str(payload["task"]["status"])


def require_status(cli: Path, board: str, task_id: str, expected: str) -> None:
    actual = task_status(cli, board, task_id)
    if actual != expected:
        raise CanaryError(f"task {task_id}: expected {expected}, received {actual}")


def create_task(cli: Path, board: str, title: str, key: str, *extra: str) -> str:
    payload = run_json(
        cli,
        "kanban",
        "--board",
        board,
        "create",
        title,
        "--idempotency-key",
        key,
        "--created-by",
        "valkhana-canary",
        *extra,
        "--json",
    )
    return str(payload["id"])


def lifecycle_probe(cli: Path, board: str) -> dict[str, Any]:
    if not board.startswith(CANARY_BOARD_PREFIXES):
        raise CanaryError(f"refusing mutation on non-canary board: {board}")

    boards = run_json(cli, "kanban", "boards", "list", "--json")
    selected = next((item for item in boards if item.get("slug") == board), None)
    if selected is None:
        raise CanaryError(f"canary board does not exist: {board}")
    if selected.get("is_current"):
        raise CanaryError("refusing mutation: canary board must not be globally current")

    suffix = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + f"-{os.getpid()}"
    parent_id: str | None = None
    child_id: str | None = None
    try:
        parent_id = create_task(
            cli,
            board,
            "ValKhana canary dependency parent",
            f"valkhana-canary-parent-{suffix}",
        )
        require_status(cli, board, parent_id, "ready")
        run(
            cli,
            "kanban",
            "--board",
            board,
            "block",
            "--kind",
            "needs_input",
            parent_id,
            "ValKhana canary dependency gate",
        )
        require_status(cli, board, parent_id, "blocked")

        child_id = create_task(
            cli,
            board,
            "ValKhana canary dependency child",
            f"valkhana-canary-child-{suffix}",
            "--parent",
            parent_id,
        )
        require_status(cli, board, child_id, "todo")
        run(
            cli,
            "kanban",
            "--board",
            board,
            "complete",
            parent_id,
            "--result",
            "Canary dependency approved",
            "--summary",
            "Parent gate satisfied by guarded canary",
        )
        require_status(cli, board, child_id, "ready")

        run(
            cli,
            "kanban",
            "--board",
            board,
            "request-review",
            child_id,
            "--summary",
            "Guarded lifecycle canary ready for review",
            "--reviewer",
            "valkhana-canary-reviewer",
            "--metadata",
            '{"canary":true}',
        )
        require_status(cli, board, child_id, "review")
        run(
            cli,
            "kanban",
            "--board",
            board,
            "reopen-review",
            child_id,
            "--reason",
            "Guarded lifecycle rework probe",
        )
        require_status(cli, board, child_id, "ready")
        return {
            "dependency": "pass",
            "sticky_block": "pass",
            "review": "pass",
            "rework": "pass",
            "parent_task": parent_id,
            "child_task": child_id,
        }
    finally:
        if child_id and task_status(cli, board, child_id) not in {"blocked", "done", "archived"}:
            run(
                cli,
                "kanban",
                "--board",
                board,
                "block",
                "--kind",
                "needs_input",
                child_id,
                "ValKhana canary final safety hold",
            )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes", required=True, type=Path, help="absolute Hermes CLI path")
    parser.add_argument("--minimum-version", default="0.20.2")
    parser.add_argument("--board", help="existing isolated canary board")
    parser.add_argument(
        "--lifecycle",
        action="store_true",
        help="run guarded mutations; requires --board and a non-current canary board",
    )
    arguments = parser.parse_args()

    cli = arguments.hermes
    if not cli.is_absolute() or not cli.is_file():
        raise CanaryError("--hermes must name an existing absolute file")

    version_line = run(cli, "--version").splitlines()[0]
    match = VERSION_PATTERN.match(version_line)
    if not match:
        raise CanaryError("Hermes returned an unrecognized version string")
    actual_version = tuple(int(value) for value in match.groups())
    minimum_version = tuple(int(value) for value in arguments.minimum_version.split("."))
    if actual_version < minimum_version:
        raise CanaryError(
            f"Hermes {'.'.join(map(str, actual_version))} is below "
            f"{arguments.minimum_version}"
        )

    boards = run_json(cli, "kanban", "boards", "list", "--json")
    audit = run_json(cli, "security", "audit", "--json", timeout=120)
    if audit.get("finding_count") != 0:
        raise CanaryError(f"Hermes security audit has {audit.get('finding_count')} finding(s)")

    report: dict[str, Any] = {
        "version": version_line,
        "minimum_version": arguments.minimum_version,
        "board_discovery": "pass",
        "board_count": len(boards),
        "security_audit": "pass",
        "components_scanned": audit.get("total_components_scanned"),
        "lifecycle": "not_requested",
    }
    if arguments.lifecycle:
        if not arguments.board:
            raise CanaryError("--lifecycle requires --board")
        report["lifecycle"] = lifecycle_probe(cli, arguments.board)

    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CanaryError as error:
        print(json.dumps({"status": "failed", "error": str(error)}, indent=2))
        raise SystemExit(1) from None
