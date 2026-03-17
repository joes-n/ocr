from pathlib import Path
import json
import logging
import os
import time
import traceback
import uuid

import cv2
from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import numpy as np

logger = logging.getLogger("uvicorn.error")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

os.environ["FLAGS_allocator_strategy"] = "auto_growth"
os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"

from paddleocr import PaddleOCR

logger.info("Initializing PaddleOCR primary OCR (mobile det+rec)...")
ocr_mobile = PaddleOCR(
    text_detection_model_name="PP-OCRv5_mobile_det",
    text_recognition_model_name="PP-OCRv5_mobile_rec",
    use_doc_orientation_classify=False,
    use_doc_unwarping=False,
    use_textline_orientation=False,
    enable_mkldnn=True,
)
logger.info("PaddleOCR primary OCR initialized.")

logger.info("Initializing PaddleOCR fallback OCR (server det+rec)...")
ocr_fallback = PaddleOCR(
    text_detection_model_name="PP-OCRv5_server_det",
    text_recognition_model_name="PP-OCRv5_server_rec",
    use_doc_orientation_classify=False,
    use_doc_unwarping=False,
    use_textline_orientation=False,
    enable_mkldnn=True,
)
logger.info("PaddleOCR fallback OCR initialized.")

MAX_IMAGE_SIDE = 1920
BOTTOM_ROI_FRACTION = 0.5
LEFT_ROI_FRACTION = 0.6
DEBUG_ARTIFACT_DIR = os.environ.get("OCR_DEBUG_DIR", "").strip()
DEBUG_SAVE_IMAGES = os.environ.get("OCR_DEBUG_SAVE_IMAGES", "true").strip().lower() not in {
    "",
    "0",
    "false",
    "no",
    "off",
}


def _rounded(value: float, digits: int = 4) -> float:
    return round(float(value), digits)


def _bbox_dict(bbox):
    if bbox is None:
        return None
    x, y, w, h = bbox
    return {"x": int(x), "y": int(y), "w": int(w), "h": int(h)}


def _utc_timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


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


def crop_bottom_roi(img: np.ndarray):
    height, width = img.shape[:2]
    y_start = max(0, min(height - 1, int(height * (1.0 - BOTTOM_ROI_FRACTION))))
    x_end = max(1, min(width, int(width * LEFT_ROI_FRACTION)))
    roi = img[y_start:height, 0:x_end]
    bbox = (0, y_start, x_end, max(1, height - y_start))
    return roi, bbox


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


@app.post("/ocr")
async def process_image(file: UploadFile = File(...)):
    logger.info("Received request /ocr")
    total_start = time.perf_counter()
    request_id = uuid.uuid4().hex[:8]
    debug_dir, attempt_number = _create_debug_dir()
    artifacts = {}

    try:
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
        roi_img, roi_bbox = crop_bottom_roi(img)
        crop_ms = (time.perf_counter() - crop_start) * 1000.0

        artifacts["roi_bottom50_left60"] = _save_image_artifact(
            debug_dir,
            _make_artifact_entry("roi_bottom50_left60.jpg", enabled=DEBUG_SAVE_IMAGES),
            roi_img,
        )

        label_debug = {
            "strategy": "bottom_50_percent_left_60_percent_roi",
            "roi_fraction": BOTTOM_ROI_FRACTION,
            "left_fraction": LEFT_ROI_FRACTION,
            "selected_pass": None,
            "selected_bbox": None,
            "selected_candidate": None,
            "validation_attempts": [],
            "roi_bbox": _bbox_dict(roi_bbox),
            "mobile_error": None,
        }

        mobile_ocr_ms = 0.0
        fallback_ocr_ms = 0.0
        output = []
        path = "mobile_bottom50_left60_roi"

        try:
            mobile_start = time.perf_counter()
            output = run_ocr(ocr_mobile, roi_img, box_offset=(roi_bbox[0], roi_bbox[1]))
            mobile_ocr_ms = (time.perf_counter() - mobile_start) * 1000.0
            label_debug["validation_attempts"].append(
                {
                    "stage": "mobile_bottom50_left60_roi",
                    "output_count": len(output),
                    "ocr_ms": _rounded(mobile_ocr_ms, 2),
                    "accepted": bool(output),
                }
            )
        except Exception as mobile_exc:
            path = "fallback_mobile_error"
            label_debug["mobile_error"] = str(mobile_exc)
            output = []
            logger.error(
                "request_id=%s attempt=%s mobile OCR failed: %s",
                request_id,
                attempt_number,
                mobile_exc,
            )
            logger.error(traceback.format_exc())

        if output:
            label_debug["selected_pass"] = "mobile_bottom50_left60_roi"
            label_debug["selected_bbox"] = _bbox_dict(roi_bbox)
            label_debug["selected_candidate"] = {
                "engine": "PP-OCRv5_mobile_det+PP-OCRv5_mobile_rec",
                "roi_fraction": BOTTOM_ROI_FRACTION,
                "left_fraction": LEFT_ROI_FRACTION,
            }
            path = "mobile_bottom50_left60_roi"
        else:
            if path != "fallback_mobile_error":
                path = "fallback_mobile_empty"

            fallback_start = time.perf_counter()
            output = run_ocr(ocr_fallback, img)
            fallback_ocr_ms = (time.perf_counter() - fallback_start) * 1000.0

            label_debug["validation_attempts"].append(
                {
                    "stage": "server_full_frame_fallback",
                    "output_count": len(output),
                    "ocr_ms": _rounded(fallback_ocr_ms, 2),
                    "accepted": bool(output),
                }
            )
            label_debug["selected_pass"] = "server_full_frame_fallback"
            label_debug["selected_bbox"] = _bbox_dict((0, 0, img.shape[1], img.shape[0]))
            label_debug["selected_candidate"] = {
                "engine": "PP-OCRv5_server_det+PP-OCRv5_server_rec",
                "reason": path,
            }

        total_ms = (time.perf_counter() - total_start) * 1000.0
        profiling = {
            "path": path,
            "decode_ms": round(decode_ms, 2),
            "label_detect_ms": 0.0,
            "crop_ms": round(crop_ms, 2),
            "seg_ms": 0.0,
            "ocr_ms": round(mobile_ocr_ms + fallback_ocr_ms, 2),
            "mobile_ocr_ms": round(mobile_ocr_ms, 2),
            "fallback_ocr_ms": round(fallback_ocr_ms, 2),
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
        return {"results": output, "profiling": profiling, "debug": payload["debug"]}

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
            },
        )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
