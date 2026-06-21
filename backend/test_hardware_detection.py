from __future__ import annotations

import json
import unittest

try:
    from backend.hardware_detection import CommandResult, detect_nvidia_gpu
except ImportError:
    from hardware_detection import CommandResult, detect_nvidia_gpu


class NvidiaGpuDetectionTests(unittest.TestCase):
    def test_detects_nvidia_from_nvidia_smi(self) -> None:
        def runner(command):
            self.assertEqual(command[0], "nvidia-smi")
            return CommandResult(returncode=0, stdout="NVIDIA GeForce RTX 4070 Laptop GPU\n")

        detected = detect_nvidia_gpu(
            runner=runner,
            os_name="posix",
            nvidia_smi_candidates=["nvidia-smi"],
        )

        self.assertTrue(detected.present)
        self.assertEqual(detected.source, "nvidia-smi")
        self.assertEqual(detected.name, "NVIDIA GeForce RTX 4070 Laptop GPU")

    def test_detects_nvidia_from_windows_adapter_name(self) -> None:
        def runner(command):
            if command[0] == "nvidia-smi":
                return CommandResult(returncode=1, stderr="not found")
            return CommandResult(
                returncode=0,
                stdout=json.dumps(
                    [
                        {
                            "Name": "NVIDIA GeForce RTX 4070 Laptop GPU",
                            "AdapterCompatibility": "NVIDIA",
                            "PNPDeviceID": "PCI\\VEN_10DE&DEV_2860",
                        }
                    ]
                ),
            )

        detected = detect_nvidia_gpu(
            runner=runner,
            os_name="nt",
            nvidia_smi_candidates=["nvidia-smi"],
        )

        self.assertTrue(detected.present)
        self.assertEqual(detected.source, "win32_video_controller")
        self.assertIn("4070", detected.name)

    def test_detects_nvidia_from_windows_pci_vendor_id(self) -> None:
        def runner(command):
            if command[0] == "nvidia-smi":
                return CommandResult(returncode=1)
            return CommandResult(
                returncode=0,
                stdout=json.dumps(
                    {
                        "Name": "3D Video Controller",
                        "AdapterCompatibility": "Microsoft",
                        "PNPDeviceID": "PCI\\VEN_10DE&DEV_28E0",
                    }
                ),
            )

        detected = detect_nvidia_gpu(
            runner=runner,
            os_name="nt",
            nvidia_smi_candidates=["nvidia-smi"],
        )

        self.assertTrue(detected.present)
        self.assertEqual(detected.name, "3D Video Controller")

    def test_no_gpu_when_no_detector_matches(self) -> None:
        def runner(command):
            if command[0] == "nvidia-smi":
                return CommandResult(returncode=1)
            return CommandResult(
                returncode=0,
                stdout=json.dumps(
                    [
                        {
                            "Name": "AMD Radeon RX 7900 XT",
                            "AdapterCompatibility": "Advanced Micro Devices, Inc.",
                            "PNPDeviceID": "PCI\\VEN_1002&DEV_744C",
                        }
                    ]
                ),
            )

        detected = detect_nvidia_gpu(
            runner=runner,
            os_name="nt",
            nvidia_smi_candidates=["nvidia-smi"],
        )

        self.assertFalse(detected.present)


if __name__ == "__main__":
    unittest.main()
