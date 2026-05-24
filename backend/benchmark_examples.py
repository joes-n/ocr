from __future__ import annotations

import argparse
import json
from pathlib import Path
import statistics
import time
from typing import Any

import cv2

try:
    from .main import (
        BOTTOM_ROI_FRACTION,
        BOTTOM_WIDE_ROI_FRACTION,
        FALLBACK_DETECTION_MODEL,
        FALLBACK_RECOGNITION_MODEL,
        FULL_WIDTH_ROI_FRACTION,
        LEFT_ROI_FRACTION,
        MOBILE_DETECTION_MODEL,
        MOBILE_RECOGNITION_MODEL,
        create_paddle_ocr_engine,
        crop_bottom_roi,
        run_ocr,
    )
    from .ocr_device import detect_paddle_cuda_status, resolve_ocr_device
    from .ocr_scoring import score_ocr_items
except ImportError:
    from main import (
        BOTTOM_ROI_FRACTION,
        BOTTOM_WIDE_ROI_FRACTION,
        FALLBACK_DETECTION_MODEL,
        FALLBACK_RECOGNITION_MODEL,
        FULL_WIDTH_ROI_FRACTION,
        LEFT_ROI_FRACTION,
        MOBILE_DETECTION_MODEL,
        MOBILE_RECOGNITION_MODEL,
        create_paddle_ocr_engine,
        crop_bottom_roi,
        run_ocr,
    )
    from ocr_device import detect_paddle_cuda_status, resolve_ocr_device
    from ocr_scoring import score_ocr_items


REPO_ROOT = Path(__file__).resolve().parent.parent


def _default_images() -> list[Path]:
    images = sorted(REPO_ROOT.glob("text_line_*.jpg"))
    ticket_example = REPO_ROOT / "ticket_example.jpg"
    if ticket_example.is_file():
        images.append(ticket_example)
    return images


def _round_ms(value: float) -> float:
    return round(float(value), 2)


def _selected_text(scored: dict[str, Any], key: str) -> str | None:
    selected = scored.get(key)
    if not isinstance(selected, dict):
        return None
    text = selected.get("text")
    return str(text) if text is not None else None


def _run_backend_flow(mobile, fallback, image_path: Path) -> dict[str, Any]:
    img = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"Could not read image: {image_path}")

    attempts = []
    mobile_ocr_ms = 0.0
    fallback_ocr_ms = 0.0
    for stage, bottom_fraction, left_fraction in [
        ("bottom50_left60_mobile", BOTTOM_ROI_FRACTION, LEFT_ROI_FRACTION),
        ("bottom60_fullwidth_mobile", BOTTOM_WIDE_ROI_FRACTION, FULL_WIDTH_ROI_FRACTION),
    ]:
        roi_img, roi_bbox = crop_bottom_roi(
            img,
            bottom_fraction=bottom_fraction,
            left_fraction=left_fraction,
        )
        start = time.perf_counter()
        output = run_ocr(mobile, roi_img, box_offset=(roi_bbox[0], roi_bbox[1]))
        ocr_ms = (time.perf_counter() - start) * 1000.0
        mobile_ocr_ms += ocr_ms
        attempts.append(
            {
                "stage": stage,
                "ocr_ms": ocr_ms,
                "output": output,
                "scored": score_ocr_items(output),
            }
        )

    if not any(attempt["scored"]["is_complete"] for attempt in attempts):
        start = time.perf_counter()
        output = run_ocr(fallback, img)
        fallback_ocr_ms = (time.perf_counter() - start) * 1000.0
        attempts.append(
            {
                "stage": "server_full_frame_fallback",
                "ocr_ms": fallback_ocr_ms,
                "output": output,
                "scored": score_ocr_items(output),
            }
        )

    selected = max(
        enumerate(attempts),
        key=lambda indexed: (float(indexed[1]["scored"].get("score") or 0.0), -indexed[0]),
    )[1]
    selected_scored = selected["scored"]
    return {
        "image": image_path.name,
        "image_path": str(image_path),
        "shape": {"width": int(img.shape[1]), "height": int(img.shape[0])},
        "path": selected["stage"],
        "mobile_ocr_ms": _round_ms(mobile_ocr_ms),
        "fallback_ocr_ms": _round_ms(fallback_ocr_ms),
        "total_ocr_ms": _round_ms(mobile_ocr_ms + fallback_ocr_ms),
        "output_count": len(selected["output"]),
        "is_complete": bool(selected_scored.get("is_complete")),
        "score": round(float(selected_scored.get("score") or 0.0), 4),
        "selected_name": _selected_text(selected_scored, "selected_name"),
        "selected_seat": _selected_text(selected_scored, "selected_seat"),
    }


def _summarize(records: list[dict[str, Any]]) -> dict[str, Any]:
    latencies = [float(record["total_ocr_ms"]) for record in records]
    by_image = []
    for image_name in sorted({record["image"] for record in records}):
        image_records = [record for record in records if record["image"] == image_name]
        image_latencies = [float(record["total_ocr_ms"]) for record in image_records]
        last_record = image_records[-1]
        by_image.append(
            {
                "image": image_name,
                "samples": len(image_records),
                "avg_total_ocr_ms": _round_ms(statistics.mean(image_latencies)),
                "median_total_ocr_ms": _round_ms(statistics.median(image_latencies)),
                "min_total_ocr_ms": _round_ms(min(image_latencies)),
                "max_total_ocr_ms": _round_ms(max(image_latencies)),
                "last_selected_name": last_record["selected_name"],
                "last_selected_seat": last_record["selected_seat"],
                "last_path": last_record["path"],
            }
        )

    return {
        "count": len(records),
        "avg_total_ocr_ms": _round_ms(statistics.mean(latencies)),
        "median_total_ocr_ms": _round_ms(statistics.median(latencies)),
        "min_total_ocr_ms": _round_ms(min(latencies)),
        "max_total_ocr_ms": _round_ms(max(latencies)),
        "by_image": by_image,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Benchmark backend-equivalent OCR on the repo example images.")
    parser.add_argument("images", nargs="*", type=Path, help="Optional image paths. Defaults to repo example JPEGs.")
    parser.add_argument("--device", default="auto", help="OCR device: auto, cpu, gpu, or gpu:<index>.")
    parser.add_argument("--loops", type=int, default=3, help="Measured loops over all images after one warmup.")
    parser.add_argument("--json-output", type=Path, help="Optional path to write the full benchmark report.")
    args = parser.parse_args()

    if args.loops < 1:
        raise ValueError("--loops must be at least 1")

    images = [path.expanduser().resolve() for path in args.images] if args.images else _default_images()
    if not images:
        raise ValueError("No images found. Pass image paths or add text_line_*.jpg/ticket_example.jpg.")

    cuda_status = detect_paddle_cuda_status()
    device_resolution = resolve_ocr_device(args.device, cuda_status)

    mobile_start = time.perf_counter()
    mobile = create_paddle_ocr_engine(
        text_detection_model_name=MOBILE_DETECTION_MODEL,
        text_recognition_model_name=MOBILE_RECOGNITION_MODEL,
        device_resolution=device_resolution,
    )
    mobile_init_ms = (time.perf_counter() - mobile_start) * 1000.0

    fallback_start = time.perf_counter()
    fallback = create_paddle_ocr_engine(
        text_detection_model_name=FALLBACK_DETECTION_MODEL,
        text_recognition_model_name=FALLBACK_RECOGNITION_MODEL,
        device_resolution=device_resolution,
    )
    fallback_init_ms = (time.perf_counter() - fallback_start) * 1000.0

    warmup_image = min(images, key=lambda path: path.stat().st_size)
    warmup = _run_backend_flow(mobile, fallback, warmup_image)

    records = []
    for loop_index in range(1, args.loops + 1):
        for image_path in images:
            records.append({"loop": loop_index, **_run_backend_flow(mobile, fallback, image_path)})

    report = {
        "device": device_resolution.as_status_dict(),
        "init_ms": {
            "mobile": _round_ms(mobile_init_ms),
            "fallback": _round_ms(fallback_init_ms),
            "total": _round_ms(mobile_init_ms + fallback_init_ms),
        },
        "warmup": warmup,
        "summary": _summarize(records),
        "records": records,
    }

    report_json = json.dumps(report, indent=2, ensure_ascii=True)
    print(report_json)
    if args.json_output:
        args.json_output.expanduser().write_text(report_json + "\n", encoding="utf-8")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
