#!/usr/bin/env python3
"""Verify retained model artifacts, binaries, and service identities.

This is deliberately read-only. It fails closed on a missing path, changed
SHA-256, or service unit that no longer references the recorded alias/path.
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path


ROOT = Path("/mnt/linux-data/AI")
LLAMA = "/usr/bin/llama-server"
CUSTOM_LLAMA = "/mnt/linux-data/AI/llama.cpp-fa-all-quants-10566/build-fa-all-quants/bin/llama-server"

ARTIFACTS = {
    "/mnt/linux-data/AI/models/valkhana-fleet/slot1/ornith-1.5-9b/Ornith-1.5-9B-Q8_0.gguf": "6874eeb25c71081dc8f0bbe88f3ebb786312447132745371cd980bce95d259b9",
    "/mnt/linux-data/AI/models/valkhana-fleet/slot2/gemma-4-26b-a4b/gemma-4-26B-A4B-APEX-I-Compact.gguf": "6af4e64b2060af7afa01aa44863e6192a215ee43379bd75bab4688e1f95d4212",
    "/mnt/linux-data/AI/models/valkhana-fleet/slot3/ornith-1.5-35b-a3b/Ornith-1.5-35B-A3B-APEX-Compact.gguf": "846eb4121c1b28df0e2dff06c3f3d174084231a7400c649ba02023843ea41021",
    "/mnt/linux-data/AI/models/valkhana-fleet/slot4/agents-a1/Agents-A1-APEX-I-Compact.gguf": "dbdd972647ae4c16a0c018bbf49d4b9f59e08de5f1d8c5f4cabaec275ad9e7cf",
    "/mnt/linux-data/AI/models/valkhana-fleet/slot4/agents-a1/mmproj.gguf": "c8772fe61cfceefd1bc42e3b06f53bb2e751abd15d1450d58ba0c113d3782396",
    "/mnt/linux-data/AI/models/valkhana-fleet/slot5/qwen3.8-27b/Qwen3.8-27B-UD-IQ4_XS.gguf": "40fac4050e940397dbf13087afd50f4734a11805bf9d65ef8ddd7483470e6199",
}

BINARIES = {
    LLAMA: "748a47e6e06acdf248d98fe96bbc322ad1162df2cc1d85c4033100c5dec53dd7",
    CUSTOM_LLAMA: "7978faa6de0f1be5eeb9db6d3f2a01b02a0b05e4a84742f217896b83fb17eb41",
}

SERVICES = {
    "ornith-9b.service": ("slot1-ornith-1.5-9b", ARTIFACTS.keys().__iter__().__next__()),
    "gemma-4-26b.service": ("slot2-gemma-4-26b", next(p for p in ARTIFACTS if "/slot2/" in p)),
    "ornith-llama.service": ("slot3-ornith-1.5-35b-a3b", next(p for p in ARTIFACTS if "/slot3/" in p)),
    "agents-a1.service": ("slot4-agents-a1", next(p for p in ARTIFACTS if "/slot4/" in p and "mmproj" not in p)),
    "qwen3.8.service": ("slot5-qwen3.8", next(p for p in ARTIFACTS if "/slot5/" in p)),
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def host_path(path: str) -> Path:
    """Resolve host-only paths when the verifier runs inside distrobox."""
    candidate = Path(path)
    if candidate.exists():
        return candidate
    mounted = Path("/run/host") / path.lstrip("/")
    return mounted if mounted.exists() else candidate


def main() -> int:
    failures: list[str] = []
    for name, expected in {**ARTIFACTS, **BINARIES}.items():
        path = host_path(name)
        if not path.is_file():
            failures.append(f"missing: {path}")
            continue
        actual = sha256(path)
        if actual != expected:
            failures.append(f"hash mismatch: {path} ({actual})")
        if path.suffix == ".gguf" and path.stat().st_mode & 0o222:
            failures.append(f"writable artifact: {path}")

    for service, (alias, artifact) in SERVICES.items():
        result = subprocess.run(
            ["systemctl", "--user", "show", service, "-p", "ExecStart", "--value"],
            capture_output=True,
            text=True,
            check=False,
        )
        command = result.stdout
        if result.returncode != 0 or alias not in command or artifact not in command:
            failures.append(f"service identity mismatch: {service}")

    if failures:
        for failure in failures:
            print(f"FAIL {failure}")
        return 1
    print(f"PASS retained fleet: {len(ARTIFACTS)} artifacts, {len(BINARIES)} binaries, {len(SERVICES)} services")
    return 0


if __name__ == "__main__":
    sys.exit(main())
