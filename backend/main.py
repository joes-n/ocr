from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
import json
import logging
import os
import shutil
import sys
import threading
import time
import traceback
import uuid

import cv2
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
import numpy as np


def _resource_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    return Path(__file__).resolve().parent.parent


def _default_app_data_dir() -> Path:
    if os.name == "nt":
        local_appdata = os.environ.get("LOCALAPPDATA")
        if local_appdata:
            return Path(local_appdata) / "OCRTicketReader"
    return RESOURCE_ROOT / ".runtime"


RESOURCE_ROOT = _resource_root()
PACKAGED_MODE = os.environ.get("OCR_PACKAGED_MODE", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
} or getattr(sys, "frozen", False)
APP_DATA_DIR = Path(os.environ.get("OCR_APP_DATA_DIR", "")).expanduser() if os.environ.get("OCR_APP_DATA_DIR") else _default_app_data_dir()
MODEL_CACHE_DIR = APP_DATA_DIR / "models"
LOG_DIR = APP_DATA_DIR / "logs"
TMP_DIR = APP_DATA_DIR / "tmp"
PACKAGED_ASSETS_DIR = APP_DATA_DIR / "assets"
PACKAGED_AUDIO_DIR = PACKAGED_ASSETS_DIR / "audio"
FRONTEND_DIST_DIR = RESOURCE_ROOT / "dist"
SEED_ASSETS_DIR = RESOURCE_ROOT / "seed-assets"
SEED_AUDIO_DIR = SEED_ASSETS_DIR / "audio"
LOG_FILE_PATH = LOG_DIR / "backend.log"
STATIC_EXCLUDE_PREFIXES = {
    "docs",
    "healthz",
    "ocr",
    "openapi.json",
    "redoc",
    "runtime",
    "shutdown",
}
LOCALHOST_HOSTS = {"127.0.0.1", "::1", "localhost"}

for directory in (APP_DATA_DIR, MODEL_CACHE_DIR, LOG_DIR, TMP_DIR):
    directory.mkdir(parents=True, exist_ok=True)

os.environ["FLAGS_allocator_strategy"] = "auto_growth"
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("TMPDIR", str(TMP_DIR))
os.environ.setdefault("TEMP", str(TMP_DIR))
os.environ.setdefault("TMP", str(TMP_DIR))
os.environ.setdefault("XDG_CACHE_HOME", str(APP_DATA_DIR / "cache"))
os.environ.setdefault("PADDLE_HOME", str(MODEL_CACHE_DIR / "paddle"))


def _configure_logging() -> logging.Logger:
    root_logger = logging.getLogger()
    file_handler_present = any(
        isinstance(handler, logging.FileHandler) and Path(handler.baseFilename) == LOG_FILE_PATH
        for handler in root_logger.handlers
    )

    if not root_logger.handlers:
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s %(levelname)s %(name)s %(message)s",
            handlers=[
                logging.StreamHandler(),
                logging.FileHandler(LOG_FILE_PATH, encoding="utf-8"),
            ],
        )
    elif not file_handler_present:
        file_handler = logging.FileHandler(LOG_FILE_PATH, encoding="utf-8")
        file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
        root_logger.addHandler(file_handler)

    return logging.getLogger("ocr-ticket-reader")


logger = _configure_logging()

from paddleocr import PaddleOCR

try:
    from .ocr_scoring import score_ocr_items
except ImportError:
    from ocr_scoring import score_ocr_items


@asynccontextmanager
async def lifespan(_: FastAPI):
    _seed_packaged_assets()
    logger.info("App startup: resource_root=%s packaged=%s", RESOURCE_ROOT, PACKAGED_MODE)
    runtime_manager.start()
    yield


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_IMAGE_SIDE = 1920
BOTTOM_ROI_FRACTION = 0.5
LEFT_ROI_FRACTION = 0.6
BOTTOM_WIDE_ROI_FRACTION = 0.6
FULL_WIDTH_ROI_FRACTION = 1.0
LABEL_HSV_LOWER_A = np.array([0, 20, 150])
LABEL_HSV_UPPER_A = np.array([15, 50, 220])
LABEL_HSV_LOWER_B = np.array([170, 20, 150])
LABEL_HSV_UPPER_B = np.array([180, 50, 220])
LABEL_MORPH_KERNEL_SIZE = 21
LABEL_MIN_AREA_FRACTION = 0.01
LABEL_MIN_SOLIDITY = 0.7
LABEL_ASPECT_RANGE = (0.5, 5.0)
LABEL_CROP_PAD = 0.02
DEBUG_ARTIFACT_DIR = os.environ.get("OCR_DEBUG_DIR", "").strip()
DEBUG_SAVE_IMAGES = os.environ.get("OCR_DEBUG_SAVE_IMAGES", "true").strip().lower() not in {
    "",
    "0",
    "false",
    "no",
    "off",
}


class OCRRuntimeUnavailableError(RuntimeError):
    pass


class OCRRuntimeManager:
    def __init__(self, model_cache_dir: Path):
        self._model_cache_dir = model_cache_dir
        self._lock = threading.Lock()
        self._mobile: PaddleOCR | None = None
        self._fallback: PaddleOCR | None = None
        self._thread: threading.Thread | None = None
        self._state = "starting"
        self._message = "Starting OCR runtime."
        self._error: str | None = None
        self._last_state_change = time.time()

    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return

            self._set_state_locked("starting", "Starting OCR runtime.")
            self._thread = threading.Thread(target=self._initialize, name="ocr-runtime-init", daemon=True)
            self._thread.start()

    def status(self) -> dict:
        names_csv_path = _names_csv_path()
        audio_assets_dir = _audio_assets_dir()
        with self._lock:
            return {
                "state": self._state,
                "message": self._message,
                "error": self._error,
                "is_ready": self._state == "ready" and self._mobile is not None and self._fallback is not None,
                "packaged": PACKAGED_MODE,
                "frontend_ready": FRONTEND_DIST_DIR.joinpath("index.html").is_file(),
                "frontend_root": str(FRONTEND_DIST_DIR),
                "app_data_dir": str(APP_DATA_DIR),
                "model_cache_dir": str(self._model_cache_dir),
                "log_file": str(LOG_FILE_PATH),
                "seat_assets_dir": str(PACKAGED_ASSETS_DIR if PACKAGED_MODE else RESOURCE_ROOT),
                "names_csv_path": str(names_csv_path),
                "names_csv_present": names_csv_path.is_file(),
                "audio_assets_dir": str(audio_assets_dir),
                "audio_assets_present": audio_assets_dir.is_dir() and any(audio_assets_dir.rglob("*.wav")),
                "cached_models_present": self._cached_models_present(),
                "last_state_change_utc": _utc_timestamp(self._last_state_change),
            }

    def get_engines(self) -> tuple[PaddleOCR, PaddleOCR]:
        with self._lock:
            if self._state != "ready" or self._mobile is None or self._fallback is None:
                raise OCRRuntimeUnavailableError(self._message)
            return self._mobile, self._fallback

    def _initialize(self) -> None:
        try:
            initial_state = "loading_models" if self._cached_models_present() else "downloading_models"
            initial_message = (
                "Cached OCR models found. Loading OCR models."
                if initial_state == "loading_models"
                else "Preparing OCR models. First launch may need to download model files."
            )
            self._set_state(initial_state, initial_message)

            logger.info("Initializing PaddleOCR primary OCR (mobile det+rec)...")
            mobile = PaddleOCR(
                text_detection_model_name="PP-OCRv5_mobile_det",
                text_recognition_model_name="PP-OCRv5_mobile_rec",
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                enable_mkldnn=True,
            )
            logger.info("PaddleOCR primary OCR initialized.")

            self._set_state("loading_models", "Loading fallback OCR models.")

            logger.info("Initializing PaddleOCR fallback OCR (server det+rec)...")
            fallback = PaddleOCR(
                text_detection_model_name="PP-OCRv5_server_det",
                text_recognition_model_name="PP-OCRv5_server_rec",
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                enable_mkldnn=True,
            )
            logger.info("PaddleOCR fallback OCR initialized.")

            with self._lock:
                self._mobile = mobile
                self._fallback = fallback
                self._set_state_locked("ready", "OCR runtime ready.")
        except Exception as exc:
            logger.error("Failed to initialize OCR runtime: %s", exc)
            logger.error(traceback.format_exc())
            self._set_state("error", "OCR runtime failed to initialize.", error=str(exc))

    def _cached_models_present(self) -> bool:
        if not self._model_cache_dir.exists():
            return False
        return any(self._model_cache_dir.rglob("inference.yml"))

    def _set_state(self, state: str, message: str, *, error: str | None = None) -> None:
        with self._lock:
            self._set_state_locked(state, message, error=error)

    def _set_state_locked(self, state: str, message: str, *, error: str | None = None) -> None:
        self._state = state
        self._message = message
        self._error = error
        self._last_state_change = time.time()


runtime_manager = OCRRuntimeManager(MODEL_CACHE_DIR)


def _names_csv_path() -> Path:
    if PACKAGED_MODE:
        return PACKAGED_ASSETS_DIR / "names.csv"
    return RESOURCE_ROOT / "names.csv"


def _audio_assets_dir() -> Path:
    if PACKAGED_MODE:
        return PACKAGED_AUDIO_DIR
    return RESOURCE_ROOT / "audio"


def _seed_packaged_assets() -> None:
    if not PACKAGED_MODE:
        return

    PACKAGED_ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    PACKAGED_AUDIO_DIR.mkdir(parents=True, exist_ok=True)

    seed_names_csv = SEED_ASSETS_DIR / "names.csv"
    destination_names_csv = _names_csv_path()
    if seed_names_csv.is_file() and not destination_names_csv.exists():
        shutil.copy2(seed_names_csv, destination_names_csv)
        logger.info("Seeded packaged names.csv to %s", destination_names_csv)

    if not SEED_AUDIO_DIR.is_dir():
        return

    for seed_file in SEED_AUDIO_DIR.rglob("*"):
        if not seed_file.is_file():
            continue

        destination_file = PACKAGED_AUDIO_DIR / seed_file.relative_to(SEED_AUDIO_DIR)
        if destination_file.exists():
            continue

        destination_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(seed_file, destination_file)
        logger.info("Seeded packaged audio asset to %s", destination_file)


def _audio_asset_file(relative_path: str) -> Path | None:
    normalized = relative_path.strip().strip("/\\")
    if not normalized:
        return None

    asset_root = _audio_assets_dir()
    candidate = (asset_root / normalized).resolve()
    try:
        candidate.relative_to(asset_root.resolve())
    except ValueError:
        return None

    return candidate if candidate.is_file() else None


def _missing_names_csv_message() -> str:
    path = _names_csv_path()
    if PACKAGED_MODE:
        return f"names.csv not found. Add it at {path}"
    return f"names.csv not found at {path}"


def _missing_audio_message(relative_path: str) -> str:
    asset_root = _audio_assets_dir()
    if PACKAGED_MODE:
        return f"Audio file not found. Add {relative_path} under {asset_root}"
    return f"Audio file not found at {asset_root / relative_path}"


def _rounded(value: float, digits: int = 4) -> float:
    return round(float(value), digits)


def _bbox_dict(bbox):
    if bbox is None:
        return None
    x, y, w, h = bbox
    return {"x": int(x), "y": int(y), "w": int(w), "h": int(h)}


def _utc_timestamp(epoch_seconds: float | None = None) -> str:
    timestamp = epoch_seconds if epoch_seconds is not None else time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(timestamp))


def _make_artifact_entry(filename: str, *, enabled: bool, required: bool = False) -> dict:
    return {
        "filename": filename,
        "relative_path": filename,
        "enabled": bool(enabled),
        "required": bool(required),
        "saved": False,
    }


def _create_debug_dir():
    if not DEBUG_ARTIFACT_DIR:
        return None, None

    root = Path(DEBUG_ARTIFACT_DIR)
    root.mkdir(parents=True, exist_ok=True)

    for attempt_number in range(1, 1_000_000):
        candidate = root / f"try_{attempt_number:04d}"
        try:
            candidate.mkdir()
            return candidate, attempt_number
        except FileExistsError:
            continue

    raise RuntimeError("Unable to allocate debug attempt directory")


def _save_image_artifact(debug_dir, artifact: dict, image: np.ndarray):
    if debug_dir is None or image is None or not artifact["enabled"]:
        return artifact

    artifact["saved"] = bool(cv2.imwrite(str(debug_dir / artifact["filename"]), image))
    return artifact


def _write_diag_json(debug_dir, payload: dict) -> bool:
    if debug_dir is None:
        return False
    with (debug_dir / "diag.json").open("w", encoding="utf-8") as file_handle:
        json.dump(payload, file_handle, indent=2, ensure_ascii=False)
    return True


def _resize_for_ocr(img: np.ndarray):
    height, width = img.shape[:2]
    longest_side = max(height, width)
    if longest_side <= MAX_IMAGE_SIDE:
        return img, 1.0

    scale = MAX_IMAGE_SIDE / float(longest_side)
    resized = cv2.resize(
        img,
        (max(1, int(width * scale)), max(1, int(height * scale))),
        interpolation=cv2.INTER_AREA,
    )
    return resized, scale


def _normalize_quad(raw_box, inv_scale: float, box_offset):
    if raw_box is None:
        return []
    try:
        if len(raw_box) == 0:
            return []
    except TypeError:
        return []

    offset_x, offset_y = box_offset
    points = []
    for point in raw_box:
        arr = np.asarray(point).reshape(-1)
        if arr.size < 2:
            continue
        x = (float(arr[0]) * inv_scale) + float(offset_x)
        y = (float(arr[1]) * inv_scale) + float(offset_y)
        points.append([x, y])
    return points


def _normalize_ocr_output(raw_pages, inv_scale: float = 1.0, box_offset=(0, 0)):
    output = []
    for page in raw_pages:
        if isinstance(page, dict):
            boxes = page.get("dt_polys") or []
            texts = page.get("rec_texts") or []
            confidences = page.get("rec_scores") or []
            count = min(len(texts), len(confidences))
            for idx in range(count):
                text = str(texts[idx]).strip()
                if not text:
                    continue
                raw_box = boxes[idx] if idx < len(boxes) else []
                output.append(
                    {
                        "box": _normalize_quad(raw_box, inv_scale, box_offset),
                        "text": text,
                        "confidence": float(confidences[idx]),
                    }
                )
        elif isinstance(page, list):
            for line in page:
                if len(line) < 2:
                    continue
                text = str(line[1][0]).strip()
                if not text:
                    continue
                confidence = float(line[1][1])
                output.append(
                    {
                        "box": _normalize_quad(line[0], inv_scale, box_offset),
                        "text": text,
                        "confidence": confidence,
                    }
                )
    return output


def run_ocr(ocr_engine: PaddleOCR, img: np.ndarray, box_offset=(0, 0)) -> list:
    resized, scale = _resize_for_ocr(img)
    inv_scale = (1.0 / scale) if scale != 0 else 1.0
    raw_pages = list(ocr_engine.predict(resized))
    return _normalize_ocr_output(raw_pages, inv_scale=inv_scale, box_offset=box_offset)


def crop_bottom_roi(
    img: np.ndarray,
    *,
    bottom_fraction: float = BOTTOM_ROI_FRACTION,
    left_fraction: float = LEFT_ROI_FRACTION,
):
    height, width = img.shape[:2]
    y_start = max(0, min(height - 1, int(height * (1.0 - bottom_fraction))))
    x_end = max(1, min(width, int(width * left_fraction)))
    roi = img[y_start:height, 0:x_end]
    bbox = (0, y_start, x_end, max(1, height - y_start))
    return roi, bbox


def detect_hsv_label_region(img: np.ndarray):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    mask = cv2.bitwise_or(
        cv2.inRange(hsv, LABEL_HSV_LOWER_A, LABEL_HSV_UPPER_A),
        cv2.inRange(hsv, LABEL_HSV_LOWER_B, LABEL_HSV_UPPER_B),
    )

    kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT,
        (LABEL_MORPH_KERNEL_SIZE, LABEL_MORPH_KERNEL_SIZE),
    )
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None, mask

    img_area = img.shape[0] * img.shape[1]
    min_area = img_area * LABEL_MIN_AREA_FRACTION

    best = None
    best_area = 0.0
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < min_area:
            continue
        x, y, w, h = cv2.boundingRect(contour)
        rect_area = w * h
        if rect_area == 0:
            continue
        solidity = area / rect_area
        if solidity < LABEL_MIN_SOLIDITY:
            continue
        aspect = w / h
        if aspect < LABEL_ASPECT_RANGE[0] or aspect > LABEL_ASPECT_RANGE[1]:
            continue
        if area > best_area:
            best = (x, y, w, h)
            best_area = area

    return best, mask


def crop_padded_bbox(img: np.ndarray, bbox, pad_fraction: float = LABEL_CROP_PAD):
    if bbox is None:
        return None, None

    x, y, w, h = bbox
    img_h, img_w = img.shape[:2]
    pad_x = int(w * pad_fraction)
    pad_y = int(h * pad_fraction)
    x1 = max(0, x - pad_x)
    y1 = max(0, y - pad_y)
    x2 = min(img_w, x + w + pad_x)
    y2 = min(img_h, y + h + pad_y)
    return img[y1:y2, x1:x2], (x1, y1, max(1, x2 - x1), max(1, y2 - y1))


def _compact_scored_candidate(scored: dict) -> dict:
    return {
        "is_complete": bool(scored.get("is_complete")),
        "failure_reason": scored.get("failure_reason"),
        "score": _rounded(float(scored.get("score") or 0.0), 4),
        "selected_seat": scored.get("selected_seat"),
        "selected_name": scored.get("selected_name"),
        "confidence": scored.get("confidence"),
        "seat_candidate_count": len(scored.get("seat_candidates") or []),
        "name_candidate_count": len(scored.get("name_candidates") or []),
    }


def _build_validation_attempt(
    *,
    stage: str,
    engine: str,
    bbox,
    output: list,
    ocr_ms: float,
    scored: dict,
    error: str | None = None,
) -> dict:
    return {
        "stage": stage,
        "engine": engine,
        "bbox": _bbox_dict(bbox),
        "output_count": len(output),
        "ocr_ms": _rounded(ocr_ms, 2),
        "accepted": bool(scored.get("is_complete")),
        "parse_reason": scored.get("failure_reason"),
        "score": _rounded(float(scored.get("score") or 0.0), 4),
        "selected_seat": scored.get("selected_seat"),
        "selected_name": scored.get("selected_name"),
        "confidence": scored.get("confidence"),
        "error": error,
    }


def _select_best_attempt(attempts: list[dict]):
    if not attempts:
        return None
    return max(
        enumerate(attempts),
        key=lambda indexed: (
            float(indexed[1]["scored"].get("score") or 0.0),
            -indexed[0],
        ),
    )[1]


def _build_debug_response(
    *,
    request_id: str,
    debug_dir,
    attempt_number,
    profiling: dict | None = None,
    image_shape: dict | None = None,
    label_debug: dict | None = None,
    seg_debug: dict | None = None,
    output: list | None = None,
    artifacts: dict | None = None,
    error: str | None = None,
) -> dict:
    debug = {
        "request_id": request_id,
        "attempt_number": attempt_number,
        "attempt_dir": debug_dir.name if debug_dir is not None else None,
        "artifacts_dir": str(debug_dir) if debug_dir is not None else None,
        "image_shape": image_shape,
        "artifacts": artifacts or {},
        "label_detection": label_debug,
        "segmentation": seg_debug,
        "output_count": len(output or []),
        "output_preview": (output or [])[:10],
    }

    diag = {
        "request_id": request_id,
        "timestamp_utc": _utc_timestamp(),
        "attempt": {
            "number": attempt_number,
            "dir_name": debug_dir.name if debug_dir is not None else None,
            "artifacts_dir": str(debug_dir) if debug_dir is not None else None,
        },
        "profiling": profiling,
        "artifacts": artifacts or {},
        "image_shape": image_shape,
        "label_detection": label_debug,
        "segmentation": seg_debug,
        "ocr": {
            "path": profiling.get("path") if profiling is not None else None,
            "output_count": len(output or []),
            "output_preview": (output or [])[:10],
        },
        "frontend_parser": {
            "available": False,
            "reason": "Name/seat parsing runs in the browser after the backend response.",
        },
        "error": error,
    }
    return {"debug": debug, "diag": diag}


def _service_unavailable_response(message: str, *, request_id: str, total_start: float) -> JSONResponse:
    total_ms = (time.perf_counter() - total_start) * 1000.0
    return JSONResponse(
        status_code=503,
        content={
            "error": message,
            "results": [],
            "profiling": {"total_ms": round(total_ms, 2)},
            "service_state": runtime_manager.status(),
            "debug": {
                "request_id": request_id,
                "attempt_number": None,
                "attempt_dir": None,
                "artifacts_dir": None,
            },
        },
    )


def _dist_file(relative_path: str) -> Path | None:
    if not FRONTEND_DIST_DIR.is_dir():
        return None

    normalized = relative_path.strip("/") or "index.html"
    candidate = (FRONTEND_DIST_DIR / normalized).resolve()
    try:
        candidate.relative_to(FRONTEND_DIST_DIR.resolve())
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


def _dist_index_response() -> FileResponse:
    index_file = _dist_file("index.html")
    if index_file is None:
        raise HTTPException(status_code=404, detail="Frontend build not found. Run `npm run build` first.")
    return FileResponse(index_file)


def _request_is_localhost(request: Request) -> bool:
    client_host = request.client.host if request.client else ""
    return client_host in LOCALHOST_HOSTS


def _exit_process() -> None:
    os._exit(0)


@app.get("/healthz")
async def healthz():
    status = runtime_manager.status()
    return {
        "ok": True,
        "runtime_state": status["state"],
        "runtime_message": status["message"],
        "packaged": PACKAGED_MODE,
        "frontend_ready": status["frontend_ready"],
    }


@app.get("/runtime/status")
async def runtime_status():
    return runtime_manager.status()


@app.get("/names.csv", include_in_schema=False)
async def names_csv():
    names_csv_file = _names_csv_path()
    if not names_csv_file.is_file():
        return PlainTextResponse(_missing_names_csv_message(), status_code=404)

    return FileResponse(names_csv_file, media_type="text/csv; charset=utf-8")


@app.get("/audio/{asset_path:path}", include_in_schema=False)
async def audio_asset(asset_path: str):
    audio_file = _audio_asset_file(asset_path)
    if audio_file is None:
        return PlainTextResponse(_missing_audio_message(asset_path), status_code=404)

    return FileResponse(audio_file)


@app.post("/ocr")
async def process_image(file: UploadFile = File(...)):
    logger.info("Received request /ocr")
    total_start = time.perf_counter()
    request_id = uuid.uuid4().hex[:8]
    debug_dir, attempt_number = _create_debug_dir()
    artifacts = {}

    try:
        try:
            ocr_mobile, ocr_fallback = runtime_manager.get_engines()
        except OCRRuntimeUnavailableError as exc:
            return _service_unavailable_response(str(exc), request_id=request_id, total_start=total_start)

        contents = await file.read()

        decode_start = time.perf_counter()
        nparr = np.frombuffer(contents, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        decode_ms = (time.perf_counter() - decode_start) * 1000.0

        if img is None:
            raise ValueError("Unable to decode image from upload")

        artifacts["capture"] = _save_image_artifact(
            debug_dir,
            _make_artifact_entry("capture.jpg", enabled=True, required=True),
            img,
        )

        image_shape = {"width": int(img.shape[1]), "height": int(img.shape[0])}

        crop_start = time.perf_counter()
        roi_specs = [
            {
                "stage": "bottom50_left60_mobile",
                "engine": ocr_mobile,
                "engine_label": "PP-OCRv5_mobile_det+PP-OCRv5_mobile_rec",
                "bottom_fraction": BOTTOM_ROI_FRACTION,
                "left_fraction": LEFT_ROI_FRACTION,
                "artifact_key": "roi_bottom50_left60",
                "artifact_filename": "roi_bottom50_left60.jpg",
            },
            {
                "stage": "bottom60_fullwidth_mobile",
                "engine": ocr_mobile,
                "engine_label": "PP-OCRv5_mobile_det+PP-OCRv5_mobile_rec",
                "bottom_fraction": BOTTOM_WIDE_ROI_FRACTION,
                "left_fraction": FULL_WIDTH_ROI_FRACTION,
                "artifact_key": "roi_bottom60_fullwidth",
                "artifact_filename": "roi_bottom60_fullwidth.jpg",
            },
        ]
        roi_candidates = []
        for spec in roi_specs:
            roi_img, roi_bbox = crop_bottom_roi(
                img,
                bottom_fraction=spec["bottom_fraction"],
                left_fraction=spec["left_fraction"],
            )
            roi_candidates.append({**spec, "image": roi_img, "bbox": roi_bbox})
            artifacts[spec["artifact_key"]] = _save_image_artifact(
                debug_dir,
                _make_artifact_entry(spec["artifact_filename"], enabled=DEBUG_SAVE_IMAGES),
                roi_img,
            )
        crop_ms = (time.perf_counter() - crop_start) * 1000.0

        label_detect_start = time.perf_counter()
        hsv_label_bbox, hsv_label_mask = detect_hsv_label_region(img)
        label_detect_ms = (time.perf_counter() - label_detect_start) * 1000.0
        artifacts["hsv_label_mask"] = _save_image_artifact(
            debug_dir,
            _make_artifact_entry("hsv_label_mask.jpg", enabled=DEBUG_SAVE_IMAGES),
            hsv_label_mask,
        )

        hsv_label_img, hsv_label_padded_bbox = crop_padded_bbox(img, hsv_label_bbox)
        if hsv_label_img is not None:
            artifacts["hsv_label_diagnostic"] = _save_image_artifact(
                debug_dir,
                _make_artifact_entry("hsv_label_diagnostic.jpg", enabled=DEBUG_SAVE_IMAGES),
                hsv_label_img,
            )

        label_debug = {
            "strategy": "multi_candidate_roi_score",
            "roi_candidates": [
                {
                    "stage": candidate["stage"],
                    "bottom_fraction": candidate["bottom_fraction"],
                    "left_fraction": candidate["left_fraction"],
                    "bbox": _bbox_dict(candidate["bbox"]),
                }
                for candidate in roi_candidates
            ],
            "hsv_label_candidate": {
                "raw_bbox": _bbox_dict(hsv_label_bbox),
                "padded_bbox": _bbox_dict(hsv_label_padded_bbox),
                "diagnostic_only": True,
            },
            "selected_pass": None,
            "selected_bbox": None,
            "selected_candidate": None,
            "validation_attempts": [],
            "candidate_errors": [],
        }

        mobile_ocr_ms = 0.0
        fallback_ocr_ms = 0.0
        attempts = []

        for candidate in roi_candidates:
            attempt_start = time.perf_counter()
            output = []
            error = None
            try:
                output = run_ocr(
                    candidate["engine"],
                    candidate["image"],
                    box_offset=(candidate["bbox"][0], candidate["bbox"][1]),
                )
            except Exception as mobile_exc:
                error = str(mobile_exc)
                label_debug["candidate_errors"].append({"stage": candidate["stage"], "error": error})
                logger.error(
                    "request_id=%s attempt=%s candidate=%s mobile OCR failed: %s",
                    request_id,
                    attempt_number,
                    candidate["stage"],
                    mobile_exc,
                )
                logger.error(traceback.format_exc())

            ocr_ms = (time.perf_counter() - attempt_start) * 1000.0
            mobile_ocr_ms += ocr_ms
            scored = score_ocr_items(output)
            attempt = {
                "stage": candidate["stage"],
                "engine": candidate["engine_label"],
                "bbox": candidate["bbox"],
                "output": output,
                "ocr_ms": ocr_ms,
                "scored": scored,
                "error": error,
            }
            attempts.append(attempt)
            label_debug["validation_attempts"].append(
                _build_validation_attempt(
                    stage=attempt["stage"],
                    engine=attempt["engine"],
                    bbox=attempt["bbox"],
                    output=attempt["output"],
                    ocr_ms=attempt["ocr_ms"],
                    scored=attempt["scored"],
                    error=attempt["error"],
                )
            )

        if not any(attempt["scored"]["is_complete"] for attempt in attempts):
            fallback_start = time.perf_counter()
            fallback_output = run_ocr(ocr_fallback, img)
            fallback_ocr_ms = (time.perf_counter() - fallback_start) * 1000.0
            fallback_scored = score_ocr_items(fallback_output)
            fallback_attempt = {
                "stage": "server_full_frame_fallback",
                "engine": "PP-OCRv5_server_det+PP-OCRv5_server_rec",
                "bbox": (0, 0, img.shape[1], img.shape[0]),
                "output": fallback_output,
                "ocr_ms": fallback_ocr_ms,
                "scored": fallback_scored,
                "error": None,
            }
            attempts.append(fallback_attempt)
            label_debug["validation_attempts"].append(
                _build_validation_attempt(
                    stage=fallback_attempt["stage"],
                    engine=fallback_attempt["engine"],
                    bbox=fallback_attempt["bbox"],
                    output=fallback_attempt["output"],
                    ocr_ms=fallback_attempt["ocr_ms"],
                    scored=fallback_attempt["scored"],
                )
            )

        selected_attempt = _select_best_attempt(attempts)
        selected_scored = selected_attempt["scored"] if selected_attempt is not None else score_ocr_items([])
        output = selected_attempt["output"] if selected_attempt is not None else []
        path = selected_attempt["stage"] if selected_attempt is not None else "no_ocr_attempts"
        label_debug["selected_pass"] = path
        label_debug["selected_bbox"] = _bbox_dict(selected_attempt["bbox"] if selected_attempt is not None else None)
        label_debug["selected_candidate"] = {
            "stage": path,
            "engine": selected_attempt["engine"] if selected_attempt is not None else None,
            "bbox": _bbox_dict(selected_attempt["bbox"] if selected_attempt is not None else None),
            "scoring": _compact_scored_candidate(selected_scored),
        }

        total_ms = (time.perf_counter() - total_start) * 1000.0
        profiling = {
            "path": path,
            "decode_ms": round(decode_ms, 2),
            "label_detect_ms": round(label_detect_ms, 2),
            "crop_ms": round(crop_ms, 2),
            "seg_ms": 0.0,
            "ocr_ms": round(mobile_ocr_ms + fallback_ocr_ms, 2),
            "mobile_ocr_ms": round(mobile_ocr_ms, 2),
            "fallback_ocr_ms": round(fallback_ocr_ms, 2),
            "selected_score": _rounded(float(selected_scored.get("score") or 0.0), 4),
            "total_ms": round(total_ms, 2),
        }
        payload = _build_debug_response(
            request_id=request_id,
            debug_dir=debug_dir,
            attempt_number=attempt_number,
            profiling=profiling,
            image_shape=image_shape,
            label_debug=label_debug,
            seg_debug=None,
            output=output,
            artifacts=artifacts,
        )
        if debug_dir is not None:
            artifacts["diag"] = _make_artifact_entry("diag.json", enabled=True, required=True)
            artifacts["diag"]["saved"] = _write_diag_json(debug_dir, payload["diag"])
            payload = _build_debug_response(
                request_id=request_id,
                debug_dir=debug_dir,
                attempt_number=attempt_number,
                profiling=profiling,
                image_shape=image_shape,
                label_debug=label_debug,
                seg_debug=None,
                output=output,
                artifacts=artifacts,
            )
            _write_diag_json(debug_dir, payload["diag"])

        logger.info(
            "request_id=%s attempt=%s profiling=%s",
            request_id,
            attempt_number,
            profiling,
        )
        return {
            "results": output,
            "profiling": profiling,
            "debug": payload["debug"],
            "service_state": runtime_manager.status(),
        }

    except Exception as exc:
        logger.error(
            "request_id=%s attempt=%s error processing image: %s",
            request_id,
            attempt_number,
            exc,
        )
        logger.error(traceback.format_exc())
        total_ms = (time.perf_counter() - total_start) * 1000.0
        profiling = {"total_ms": round(total_ms, 2)}
        payload = _build_debug_response(
            request_id=request_id,
            debug_dir=debug_dir,
            attempt_number=attempt_number,
            profiling=profiling,
            artifacts=artifacts,
            error=str(exc),
        )
        if debug_dir is not None:
            artifacts["diag"] = _make_artifact_entry("diag.json", enabled=True, required=True)
            artifacts["diag"]["saved"] = _write_diag_json(debug_dir, payload["diag"])
            payload = _build_debug_response(
                request_id=request_id,
                debug_dir=debug_dir,
                attempt_number=attempt_number,
                profiling=profiling,
                artifacts=artifacts,
                error=str(exc),
            )
            _write_diag_json(debug_dir, payload["diag"])

        return JSONResponse(
            status_code=500,
            content={
                "error": str(exc),
                "results": [],
                "profiling": profiling,
                "debug": payload["debug"],
                "service_state": runtime_manager.status(),
            },
        )


@app.post("/shutdown")
async def shutdown(request: Request):
    if not PACKAGED_MODE:
        raise HTTPException(status_code=404, detail="Shutdown endpoint is only enabled in packaged mode.")
    if not _request_is_localhost(request):
        raise HTTPException(status_code=403, detail="Shutdown endpoint is only available from localhost.")

    timer = threading.Timer(0.25, _exit_process)
    timer.daemon = True
    timer.start()
    return {"ok": True, "message": "Application is shutting down."}


@app.get("/", include_in_schema=False)
async def root():
    return _dist_index_response()


@app.get("/{asset_path:path}", include_in_schema=False)
async def serve_frontend(asset_path: str):
    if asset_path.split("/", 1)[0] in STATIC_EXCLUDE_PREFIXES:
        raise HTTPException(status_code=404, detail="Not found")

    asset_file = _dist_file(asset_path)
    if asset_file is not None:
        return FileResponse(asset_file)

    return _dist_index_response()


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("OCR_APP_HOST", "127.0.0.1")
    port = int(os.environ.get("OCR_APP_PORT", "8000"))
    uvicorn.run(app, host=host, port=port)
