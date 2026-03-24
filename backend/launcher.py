from __future__ import annotations

from pathlib import Path
import ctypes
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser


APP_NAME = "OCR Ticket Reader"
DEFAULT_HOST = os.environ.get("OCR_APP_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("OCR_APP_PORT", "38451"))
APP_URL = f"http://{DEFAULT_HOST}:{DEFAULT_PORT}/"
HEALTH_URL = f"http://{DEFAULT_HOST}:{DEFAULT_PORT}/healthz"
STARTUP_TIMEOUT_SECONDS = int(os.environ.get("OCR_STARTUP_TIMEOUT_SECONDS", "180"))
MUTEX_NAME = "Local\\OCRTicketReaderLauncher"


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _show_message(message: str, *, error: bool = False) -> None:
    if os.name == "nt":
        flags = 0x10 if error else 0x40
        ctypes.windll.user32.MessageBoxW(None, message, APP_NAME, flags)
        return

    stream = sys.stderr if error else sys.stdout
    print(message, file=stream)


class WindowsMutex:
    def __init__(self, name: str):
        self._name = name
        self._handle = None
        self.already_exists = False

    def acquire(self) -> bool:
        if os.name != "nt":
            return True

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._handle = kernel32.CreateMutexW(None, False, self._name)
        if not self._handle:
            raise OSError(f"CreateMutexW failed with error {ctypes.get_last_error()}")

        self.already_exists = ctypes.get_last_error() == 183
        return not self.already_exists

    def release(self) -> None:
        if os.name != "nt" or not self._handle:
            return

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CloseHandle(self._handle)
        self._handle = None


def _healthcheck(timeout_seconds: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=timeout_seconds) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def _wait_for_health(timeout_seconds: int) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if _healthcheck():
            return True
        time.sleep(1.0)
    return False


def _open_browser() -> None:
    webbrowser.open(APP_URL, new=1, autoraise=True)


def _backend_command() -> tuple[list[str], Path]:
    if getattr(sys, "frozen", False):
        launcher_dir = Path(sys.executable).resolve().parent
        backend_executable = launcher_dir / "ocr-backend" / "ocr-backend.exe"
        if not backend_executable.is_file():
            raise FileNotFoundError(f"Missing backend executable: {backend_executable}")
        return [str(backend_executable)], launcher_dir

    repo_root = _repo_root()
    return [sys.executable, "-m", "backend.main"], repo_root


def _start_backend() -> subprocess.Popen[bytes]:
    command, working_directory = _backend_command()
    env = os.environ.copy()
    env["OCR_APP_HOST"] = DEFAULT_HOST
    env["OCR_APP_PORT"] = str(DEFAULT_PORT)
    env["OCR_PACKAGED_MODE"] = "1"

    creationflags = 0
    popen_kwargs: dict[str, object] = {
        "cwd": str(working_directory),
        "env": env,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }

    if os.name == "nt":
        creationflags = (
            subprocess.CREATE_NEW_PROCESS_GROUP
            | subprocess.DETACHED_PROCESS
            | subprocess.CREATE_NO_WINDOW
        )
        popen_kwargs["creationflags"] = creationflags

    return subprocess.Popen(command, **popen_kwargs)


def main() -> int:
    if _healthcheck():
        _open_browser()
        return 0

    mutex = WindowsMutex(MUTEX_NAME)
    try:
        has_lock = mutex.acquire()
    except OSError as error:
        _show_message(f"Unable to create launcher mutex: {error}", error=True)
        return 1

    try:
        if not has_lock:
            if _wait_for_health(30):
                _open_browser()
                return 0

            _show_message(
                "The app is still starting, but the local server is not responding yet. "
                "Wait a moment and try again.",
                error=True,
            )
            return 1

        if _healthcheck():
            _open_browser()
            return 0

        try:
            _start_backend()
        except Exception as error:
            _show_message(f"Unable to start the local OCR service: {error}", error=True)
            return 1

        if not _wait_for_health(STARTUP_TIMEOUT_SECONDS):
            _show_message(
                "The local OCR service did not become ready in time. "
                "Check the packaged backend log file under %LOCALAPPDATA%\\OCRTicketReader\\logs.",
                error=True,
            )
            return 1

        _open_browser()
        return 0
    finally:
        mutex.release()


if __name__ == "__main__":
    raise SystemExit(main())
