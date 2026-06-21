from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import os
from pathlib import Path
import shutil
import subprocess
from typing import Callable, Sequence


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


@dataclass(frozen=True)
class NvidiaGpuDetection:
    present: bool
    source: str | None = None
    name: str | None = None
    error: str | None = None

    def as_status_dict(self) -> dict:
        return asdict(self)


CommandRunner = Callable[[Sequence[str]], CommandResult]


def _default_runner(command: Sequence[str]) -> CommandResult:
    try:
        completed = subprocess.run(
            list(command),
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except Exception as exc:
        return CommandResult(returncode=1, stderr=str(exc))

    return CommandResult(
        returncode=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
    )


def _nvidia_smi_candidates() -> list[str]:
    candidates = []
    path_candidate = shutil.which("nvidia-smi")
    if path_candidate:
        candidates.append(path_candidate)

    if os.name == "nt":
        for env_name in ("ProgramFiles", "ProgramW6432"):
            program_files = os.environ.get(env_name)
            if not program_files:
                continue
            candidate = str(Path(program_files) / "NVIDIA Corporation" / "NVSMI" / "nvidia-smi.exe")
            if candidate not in candidates:
                candidates.append(candidate)

    return candidates


def _first_nonempty_line(text: str) -> str | None:
    for line in text.splitlines():
        cleaned = line.strip()
        if cleaned:
            return cleaned
    return None


def _detect_with_nvidia_smi(
    runner: CommandRunner,
    candidates: Sequence[str],
) -> NvidiaGpuDetection | None:
    errors = []
    for candidate in candidates:
        if candidate != "nvidia-smi" and not Path(candidate).is_file():
            continue

        result = runner([candidate, "--query-gpu=name", "--format=csv,noheader"])
        if result.returncode == 0:
            gpu_name = _first_nonempty_line(result.stdout)
            if gpu_name:
                return NvidiaGpuDetection(present=True, source="nvidia-smi", name=gpu_name)
        elif result.stderr.strip():
            errors.append(result.stderr.strip())

    if errors:
        return NvidiaGpuDetection(present=False, error="; ".join(errors[:3]))
    return None


def _normalize_controller_records(raw_json: str) -> list[dict]:
    raw_json = raw_json.strip()
    if not raw_json:
        return []

    parsed = json.loads(raw_json)
    if isinstance(parsed, dict):
        return [parsed]
    if isinstance(parsed, list):
        return [record for record in parsed if isinstance(record, dict)]
    return []


def _detect_with_windows_video_controller(
    runner: CommandRunner,
) -> NvidiaGpuDetection | None:
    command = [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        (
            "Get-CimInstance Win32_VideoController | "
            "Select-Object Name,AdapterCompatibility,PNPDeviceID | "
            "ConvertTo-Json -Compress"
        ),
    ]
    result = runner(command)
    if result.returncode != 0:
        error = result.stderr.strip() or "Unable to query Win32_VideoController."
        return NvidiaGpuDetection(present=False, error=error)

    try:
        records = _normalize_controller_records(result.stdout)
    except json.JSONDecodeError as exc:
        return NvidiaGpuDetection(present=False, error=f"Unable to parse video controller JSON: {exc}")

    for record in records:
        name = str(record.get("Name") or "").strip()
        adapter = str(record.get("AdapterCompatibility") or "").strip()
        pnp_device_id = str(record.get("PNPDeviceID") or "").strip()
        combined = " ".join([name, adapter, pnp_device_id])
        if "nvidia" in combined.lower() or "VEN_10DE" in pnp_device_id.upper():
            return NvidiaGpuDetection(
                present=True,
                source="win32_video_controller",
                name=name or adapter or pnp_device_id,
            )

    return None


def detect_nvidia_gpu(
    *,
    runner: CommandRunner | None = None,
    os_name: str | None = None,
    nvidia_smi_candidates: Sequence[str] | None = None,
) -> NvidiaGpuDetection:
    command_runner = runner or _default_runner
    platform_name = os_name or os.name
    candidates = list(nvidia_smi_candidates) if nvidia_smi_candidates is not None else _nvidia_smi_candidates()
    errors = []

    nvidia_smi_detection = _detect_with_nvidia_smi(command_runner, candidates)
    if nvidia_smi_detection and nvidia_smi_detection.present:
        return nvidia_smi_detection
    if nvidia_smi_detection and nvidia_smi_detection.error:
        errors.append(nvidia_smi_detection.error)

    if platform_name == "nt":
        windows_detection = _detect_with_windows_video_controller(command_runner)
        if windows_detection and windows_detection.present:
            return windows_detection
        if windows_detection and windows_detection.error:
            errors.append(windows_detection.error)

    return NvidiaGpuDetection(present=False, error="; ".join(errors) or None)
