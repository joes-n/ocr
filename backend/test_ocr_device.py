from __future__ import annotations

import unittest

try:
    from backend.ocr_device import PaddleCudaStatus, resolve_ocr_device
except ImportError:
    from ocr_device import PaddleCudaStatus, resolve_ocr_device


class OCRDeviceResolutionTests(unittest.TestCase):
    def test_auto_prefers_gpu_when_cuda_device_is_visible(self) -> None:
        resolution = resolve_ocr_device("auto", PaddleCudaStatus(cuda_compiled=True, cuda_device_count=1))

        self.assertEqual(resolution.resolved, "gpu:0")
        self.assertFalse(resolution.strict)
        self.assertFalse(resolution.enable_mkldnn)

    def test_auto_falls_back_to_cpu_when_paddle_is_cpu_only(self) -> None:
        resolution = resolve_ocr_device("auto", PaddleCudaStatus(cuda_compiled=False, cuda_device_count=0))

        self.assertEqual(resolution.resolved, "cpu")
        self.assertFalse(resolution.strict)
        self.assertTrue(resolution.enable_mkldnn)
        self.assertIn("not compiled with CUDA", resolution.fallback_reason)

    def test_auto_reports_nvidia_mismatch_when_paddle_is_cpu_only(self) -> None:
        resolution = resolve_ocr_device(
            "auto",
            PaddleCudaStatus(cuda_compiled=False, cuda_device_count=0),
            nvidia_gpu_present=True,
        )

        self.assertEqual(resolution.resolved, "cpu")
        self.assertIn("NVIDIA GPU detected", resolution.fallback_reason)

    def test_explicit_cpu_is_strict_cpu(self) -> None:
        resolution = resolve_ocr_device("cpu", PaddleCudaStatus(cuda_compiled=True, cuda_device_count=1))

        self.assertEqual(resolution.resolved, "cpu")
        self.assertTrue(resolution.strict)
        self.assertTrue(resolution.enable_mkldnn)

    def test_gpu_alias_resolves_to_gpu_zero(self) -> None:
        resolution = resolve_ocr_device("gpu", PaddleCudaStatus(cuda_compiled=True, cuda_device_count=1))

        self.assertEqual(resolution.configured, "gpu:0")
        self.assertEqual(resolution.resolved, "gpu:0")
        self.assertTrue(resolution.strict)

    def test_explicit_gpu_fails_when_paddle_is_cpu_only(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "CUDA-enabled paddlepaddle-gpu"):
            resolve_ocr_device("gpu:0", PaddleCudaStatus(cuda_compiled=False, cuda_device_count=0))

    def test_explicit_gpu_fails_when_index_is_not_visible(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "reports 1 CUDA device"):
            resolve_ocr_device("gpu:1", PaddleCudaStatus(cuda_compiled=True, cuda_device_count=1))

    def test_invalid_device_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "OCR_DEVICE"):
            resolve_ocr_device("cuda", PaddleCudaStatus(cuda_compiled=True, cuda_device_count=1))


if __name__ == "__main__":
    unittest.main()
