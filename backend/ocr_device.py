from __future__ import annotations

from dataclasses import dataclass
import re


_GPU_DEVICE_RE = re.compile(r"^gpu(?::(?P<index>\d+))?$", re.IGNORECASE)


@dataclass(frozen=True)
class PaddleCudaStatus:
    cuda_compiled: bool
    cuda_device_count: int | None
    error: str | None = None


@dataclass(frozen=True)
class OCRDeviceResolution:
    configured: str
    resolved: str
    strict: bool
    cuda_compiled: bool
    cuda_device_count: int | None
    fallback_reason: str | None = None
    cuda_status_error: str | None = None

    @property
    def is_gpu(self) -> bool:
        return self.resolved.startswith("gpu:")

    @property
    def enable_mkldnn(self) -> bool:
        return self.resolved == "cpu"

    def as_status_dict(self) -> dict:
        return {
            "configured": self.configured,
            "resolved": self.resolved,
            "strict": self.strict,
            "is_gpu": self.is_gpu,
            "enable_mkldnn": self.enable_mkldnn,
            "fallback_reason": self.fallback_reason,
            "cuda_compiled": self.cuda_compiled,
            "cuda_device_count": self.cuda_device_count,
            "cuda_status_error": self.cuda_status_error,
        }


def detect_paddle_cuda_status() -> PaddleCudaStatus:
    try:
        import paddle
    except Exception as exc:
        return PaddleCudaStatus(cuda_compiled=False, cuda_device_count=None, error=str(exc))

    try:
        cuda_compiled = bool(paddle.is_compiled_with_cuda())
    except Exception as exc:
        return PaddleCudaStatus(cuda_compiled=False, cuda_device_count=None, error=str(exc))

    if not cuda_compiled:
        return PaddleCudaStatus(cuda_compiled=False, cuda_device_count=0)

    try:
        cuda_device_count = int(paddle.device.cuda.device_count())
    except Exception as exc:
        return PaddleCudaStatus(cuda_compiled=True, cuda_device_count=None, error=str(exc))

    return PaddleCudaStatus(cuda_compiled=True, cuda_device_count=cuda_device_count)


def resolve_ocr_device(
    configured: str | None,
    cuda_status: PaddleCudaStatus,
    *,
    nvidia_gpu_present: bool = False,
) -> OCRDeviceResolution:
    configured_device = (configured or "auto").strip().lower() or "auto"

    if configured_device == "auto":
        if cuda_status.cuda_compiled and (cuda_status.cuda_device_count or 0) > 0:
            return OCRDeviceResolution(
                configured=configured_device,
                resolved="gpu:0",
                strict=False,
                cuda_compiled=cuda_status.cuda_compiled,
                cuda_device_count=cuda_status.cuda_device_count,
                cuda_status_error=cuda_status.error,
            )

        return OCRDeviceResolution(
            configured=configured_device,
            resolved="cpu",
            strict=False,
            cuda_compiled=cuda_status.cuda_compiled,
            cuda_device_count=cuda_status.cuda_device_count,
            fallback_reason=_auto_cpu_fallback_reason(cuda_status, nvidia_gpu_present=nvidia_gpu_present),
            cuda_status_error=cuda_status.error,
        )

    if configured_device == "cpu":
        return OCRDeviceResolution(
            configured=configured_device,
            resolved="cpu",
            strict=True,
            cuda_compiled=cuda_status.cuda_compiled,
            cuda_device_count=cuda_status.cuda_device_count,
            cuda_status_error=cuda_status.error,
        )

    gpu_match = _GPU_DEVICE_RE.fullmatch(configured_device)
    if gpu_match:
        gpu_index = int(gpu_match.group("index") or 0)
        resolved = f"gpu:{gpu_index}"
        if not cuda_status.cuda_compiled:
            raise RuntimeError(
                f"OCR_DEVICE={resolved} requires a CUDA-enabled paddlepaddle-gpu install. "
                "The current PaddlePaddle package is CPU-only."
            )
        if cuda_status.cuda_device_count is None:
            detail = f" {cuda_status.error}" if cuda_status.error else ""
            raise RuntimeError(f"OCR_DEVICE={resolved} requires a visible CUDA device count.{detail}")
        if cuda_status.cuda_device_count <= gpu_index:
            raise RuntimeError(
                f"OCR_DEVICE={resolved} requested CUDA device index {gpu_index}, "
                f"but PaddlePaddle reports {cuda_status.cuda_device_count} CUDA device(s)."
            )
        return OCRDeviceResolution(
            configured=resolved,
            resolved=resolved,
            strict=True,
            cuda_compiled=cuda_status.cuda_compiled,
            cuda_device_count=cuda_status.cuda_device_count,
            cuda_status_error=cuda_status.error,
        )

    raise ValueError("OCR_DEVICE must be one of: auto, cpu, gpu, gpu:<index>.")


def _auto_cpu_fallback_reason(cuda_status: PaddleCudaStatus, *, nvidia_gpu_present: bool = False) -> str:
    if not cuda_status.cuda_compiled:
        if nvidia_gpu_present:
            return "NVIDIA GPU detected, but installed PaddlePaddle is not compiled with CUDA."
        return "Installed PaddlePaddle is not compiled with CUDA."
    if cuda_status.cuda_device_count is None:
        return "CUDA device count is unavailable."
    if cuda_status.cuda_device_count <= 0:
        return "No CUDA devices are visible to PaddlePaddle."
    return "CUDA is unavailable; using CPU."
