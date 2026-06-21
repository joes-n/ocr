from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys

try:
    from .hardware_detection import detect_nvidia_gpu
except ImportError:
    from hardware_detection import detect_nvidia_gpu


PADDLE_VERSION = "3.2.2"
GPU_INDEX_URL = "https://www.paddlepaddle.org.cn/packages/stable/cu126/"


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _run(command: list[str], *, dry_run: bool) -> None:
    print("+ " + " ".join(command))
    if dry_run:
        return
    subprocess.run(command, check=True)


def _verify_paddle() -> dict:
    verify_code = (
        "import json, paddle; "
        "print(json.dumps({"
        "'version': paddle.__version__, "
        "'cuda_compiled': bool(paddle.is_compiled_with_cuda()), "
        "'cuda_device_count': int(paddle.device.cuda.device_count())"
        "}))"
    )
    completed = subprocess.run(
        [sys.executable, "-c", verify_code],
        capture_output=True,
        text=True,
        check=True,
    )
    lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    return json.loads(lines[-1])


def _install_runtime(runtime: str, *, dry_run: bool, gpu_index_url: str) -> None:
    pip_base = [sys.executable, "-m", "pip"]
    common_requirements = _repo_root() / "backend" / "requirements-common.txt"

    _run([*pip_base, "install", "-r", str(common_requirements)], dry_run=dry_run)
    _run([*pip_base, "uninstall", "-y", "paddlepaddle", "paddlepaddle-gpu"], dry_run=dry_run)

    if runtime == "gpu":
        _run(
            [
                *pip_base,
                "install",
                f"paddlepaddle-gpu=={PADDLE_VERSION}",
                "-i",
                gpu_index_url,
            ],
            dry_run=dry_run,
        )
    else:
        _run([*pip_base, "install", f"paddlepaddle=={PADDLE_VERSION}"], dry_run=dry_run)


def main() -> int:
    parser = argparse.ArgumentParser(description="Install backend dependencies with CPU/GPU Paddle selection.")
    parser.add_argument(
        "--runtime",
        choices=("auto", "cpu", "gpu"),
        default="auto",
        help="Paddle runtime to install. auto selects gpu when an NVIDIA GPU is detected.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print detection and pip commands without installing.")
    parser.add_argument("--gpu-index-url", default=GPU_INDEX_URL, help="Paddle GPU wheel package index URL.")
    args = parser.parse_args()

    nvidia = detect_nvidia_gpu()
    selected_runtime = "gpu" if args.runtime == "gpu" or (args.runtime == "auto" and nvidia.present) else "cpu"

    report = {
        "requested_runtime": args.runtime,
        "selected_runtime": selected_runtime,
        "nvidia_gpu": nvidia.as_status_dict(),
        "paddle_version": PADDLE_VERSION,
        "gpu_index_url": args.gpu_index_url,
        "dry_run": args.dry_run,
    }
    print(json.dumps(report, indent=2))

    _install_runtime(selected_runtime, dry_run=args.dry_run, gpu_index_url=args.gpu_index_url)

    if args.dry_run:
        return 0

    verification = _verify_paddle()
    print(json.dumps({"paddle_verification": verification}, indent=2))
    if selected_runtime == "gpu" and not verification.get("cuda_compiled"):
        print("Expected a CUDA-enabled PaddlePaddle install, but Paddle reports cuda_compiled=false.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
