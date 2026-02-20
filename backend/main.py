from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import logging
import traceback
import time
import cv2
import numpy as np

logger = logging.getLogger("uvicorn.error")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

import os

os.environ["FLAGS_allocator_strategy"] = "auto_growth"
os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
from paddleocr import PaddleOCR, TextRecognition

# Fast path: mobile recognition model, used after OpenCV line segmentation.
# enable_mkldnn requires paddlepaddle 3.2.2.
logger.info("Initializing TextRecognition (mobile rec)...")
rec_model = TextRecognition(
    model_name="PP-OCRv5_mobile_rec",
    enable_mkldnn=True,
)
logger.info("TextRecognition initialized.")

# Fallback: full PaddleOCR pipeline, used when OpenCV line segmentation
# fails (e.g. no lines found) or when no label is detected.
logger.info("Initializing PaddleOCR fallback (server models)...")
ocr_fallback = PaddleOCR(
    text_detection_model_name="PP-OCRv5_server_det",
    text_recognition_model_name="PP-OCRv5_server_rec",
    use_doc_orientation_classify=False,
    use_doc_unwarping=False,
    use_textline_orientation=False,
    enable_mkldnn=True,
)
logger.info("PaddleOCR fallback initialized.")

MAX_IMAGE_SIDE = 1920

# HSV thresholds for detecting the pink/salmon name label.
# Pink hue wraps around 0 in OpenCV's [0,180] H range, so two intervals are needed.
LABEL_HSV_LOWER_A = np.array([0, 20, 150])
LABEL_HSV_UPPER_A = np.array([15, 50, 220])
LABEL_HSV_LOWER_B = np.array([170, 20, 150])
LABEL_HSV_UPPER_B = np.array([180, 50, 220])
LABEL_MORPH_KERNEL_SIZE = 21
LABEL_MIN_AREA_FRACTION = 0.01  # contour must be >1% of image area
LABEL_MIN_SOLIDITY = 0.7  # reject irregular shapes like watermarks
LABEL_ASPECT_RANGE = (0.5, 5.0)  # reject very thin strips
LABEL_CROP_PAD = 0.02  # 2% padding around detected bbox


def detect_label_region(img: np.ndarray):
    """Detect the pink/salmon name label via HSV color segmentation.

    Returns (x, y, w, h) bounding box of the label, or None if not found.
    """
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
        return None

    img_area = img.shape[0] * img.shape[1]
    min_area = img_area * LABEL_MIN_AREA_FRACTION

    best = None
    best_area = 0
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < min_area:
            continue
        x, y, w, h = cv2.boundingRect(cnt)
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

    return best


def crop_label(img: np.ndarray, bbox) -> np.ndarray:
    """Crop image to label bbox with a small padding margin.

    No resize is applied here — segmentation and recognition work at full
    label resolution for best accuracy.
    """
    x, y, w, h = bbox
    img_h, img_w = img.shape[:2]

    pad_x = int(w * LABEL_CROP_PAD)
    pad_y = int(h * LABEL_CROP_PAD)
    x1 = max(0, x - pad_x)
    y1 = max(0, y - pad_y)
    x2 = min(img_w, x + w + pad_x)
    y2 = min(img_h, y + h + pad_y)

    return img[y1:y2, x1:x2]


# Minimum ink-pixel row density (fraction of label width) to be counted as text.
SEG_ROW_INK_FRACTION = 0.02
# Minimum band height in pixels to be considered a text line.
SEG_MIN_BAND_HEIGHT = 15
# Vertical padding added around each detected text band (fraction of band height).
SEG_BAND_PAD_FRACTION = 0.15
# Minimum ink-pixel column density to include in the horizontal crop.
SEG_COL_MIN_INK = 2


def segment_text_lines(label_img: np.ndarray) -> list:
    """Segment a label image into individual text-line crops using
    horizontal projection of binarized ink pixels.

    Returns a list of BGR image crops, one per text line, sorted top-to-bottom.
    Returns an empty list if no lines are found.
    """
    gray = cv2.cvtColor(label_img, cv2.COLOR_BGR2GRAY)

    # Otsu binarization: ink → white (255), background → black (0).
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Horizontal projection: number of ink pixels per row.
    h_proj = np.sum(binary, axis=1) / 255.0
    ink_threshold = label_img.shape[1] * SEG_ROW_INK_FRACTION
    text_rows = h_proj > ink_threshold

    # Group consecutive text rows into bands.
    in_band = False
    bands = []
    band_start = 0
    for i, is_text in enumerate(text_rows):
        if is_text and not in_band:
            band_start = i
            in_band = True
        elif not is_text and in_band:
            bands.append((band_start, i))
            in_band = False
    if in_band:
        bands.append((band_start, len(text_rows)))

    label_h, label_w = label_img.shape[:2]
    line_crops = []

    for y_start, y_end in bands:
        band_h = y_end - y_start
        if band_h < SEG_MIN_BAND_HEIGHT:
            continue

        # Vertical padding.
        v_pad = max(5, int(band_h * SEG_BAND_PAD_FRACTION))
        y1 = max(0, y_start - v_pad)
        y2 = min(label_h, y_end + v_pad)

        # Horizontal extent: find columns with enough ink in this band.
        band_bin = binary[y_start:y_end, :]
        col_ink = np.sum(band_bin, axis=0) / 255.0
        text_cols = np.where(col_ink > SEG_COL_MIN_INK)[0]
        if len(text_cols) == 0:
            continue
        x1 = max(0, int(text_cols[0]) - 10)
        x2 = min(label_w, int(text_cols[-1]) + 10)

        line_crops.append(label_img[y1:y2, x1:x2])

    return line_crops


def run_rec_on_lines(line_crops: list) -> list:
    """Run TextRecognition on each line crop and return OCR items.

    Returns a list of dicts with 'text' and 'confidence' (no 'box', since
    we bypassed the detection step).
    """
    output = []
    for crop in line_crops:
        for page in rec_model.predict(crop):
            if not isinstance(page, dict):
                continue
            text = page.get("rec_text", "")
            score = page.get("rec_score", 0.0)
            if text:
                output.append(
                    {"box": [], "text": str(text), "confidence": float(score)}
                )
    return output


def run_fallback_ocr(img: np.ndarray) -> list:
    """Run the full PaddleOCR pipeline (det + rec) on img.

    Used when OpenCV line segmentation yields no lines, or when no label
    is detected.  Resizes to MAX_IMAGE_SIDE first to cap memory usage.
    """
    height, width = img.shape[:2]
    longest_side = max(height, width)
    if longest_side > MAX_IMAGE_SIDE:
        scale = MAX_IMAGE_SIDE / float(longest_side)
        img = cv2.resize(
            img,
            (max(1, int(width * scale)), max(1, int(height * scale))),
            interpolation=cv2.INTER_AREA,
        )

    output = []
    for page in ocr_fallback.predict(img):
        if isinstance(page, dict):
            boxes = page.get("dt_polys") or []
            texts = page.get("rec_texts") or []
            confidences = page.get("rec_scores") or []
            count = min(len(texts), len(confidences))
            for idx in range(count):
                raw_box = boxes[idx] if idx < len(boxes) else []
                output.append(
                    {
                        "box": [[float(p[0]), float(p[1])] for p in raw_box],
                        "text": str(texts[idx]),
                        "confidence": float(confidences[idx]),
                    }
                )
        elif isinstance(page, list):
            for line in page:
                if len(line) >= 2:
                    box = line[0]
                    text = line[1][0]
                    confidence = float(line[1][1])
                    output.append(
                        {
                            "box": [[float(p[0]), float(p[1])] for p in box],
                            "text": text,
                            "confidence": confidence,
                        }
                    )
    return output


@app.post("/ocr")
async def process_image(file: UploadFile = File(...)):
    logger.info("Received request /ocr")
    total_start = time.perf_counter()
    try:
        contents = await file.read()

        decode_start = time.perf_counter()
        nparr = np.frombuffer(contents, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        decode_ms = (time.perf_counter() - decode_start) * 1000.0

        if img is None:
            raise ValueError("Unable to decode image from upload")

        # --- Step 1: Detect the pink label via HSV color segmentation. ---
        label_detect_start = time.perf_counter()
        bbox = detect_label_region(img)
        label_detect_ms = (time.perf_counter() - label_detect_start) * 1000.0

        if bbox is None:
            logger.info("Label not detected — using full-frame fallback OCR")
            output = run_fallback_ocr(img)
            path = "fallback_no_label"
            seg_ms = 0.0
            ocr_ms = (time.perf_counter() - label_detect_start) * 1000.0
        else:
            x, y, w, h = bbox
            logger.info(f"Label detected at ({x},{y},{w},{h})")

            # --- Step 2: Crop the label (no resize). ---
            crop_start = time.perf_counter()
            label_img = crop_label(img, bbox)
            crop_ms = (time.perf_counter() - crop_start) * 1000.0

            # --- Step 3: Segment the label into text lines via OpenCV. ---
            seg_start = time.perf_counter()
            line_crops = segment_text_lines(label_img)
            seg_ms = (time.perf_counter() - seg_start) * 1000.0
            logger.info(
                f"Segmented {len(line_crops)} text lines "
                f"({label_img.shape[1]}x{label_img.shape[0]} label)"
            )

            # --- Step 4: Recognize each line (rec-only, no detection). ---
            ocr_start = time.perf_counter()
            if line_crops:
                output = run_rec_on_lines(line_crops)
                path = "fast_seg_rec"
            else:
                logger.info(
                    "No lines segmented — using full-frame fallback OCR on label"
                )
                output = run_fallback_ocr(label_img)
                path = "fallback_no_lines"
            ocr_ms = (time.perf_counter() - ocr_start) * 1000.0

        total_ms = (time.perf_counter() - total_start) * 1000.0
        profiling = {
            "path": path,
            "decode_ms": round(decode_ms, 2),
            "label_detect_ms": round(label_detect_ms, 2),
            "seg_ms": round(seg_ms, 2),
            "ocr_ms": round(ocr_ms, 2),
            "total_ms": round(total_ms, 2),
        }
        logger.info(f"Profiling: {profiling}")
        return {"results": output, "profiling": profiling}

    except Exception as e:
        logger.error(f"Error processing image: {e}")
        logger.error(traceback.format_exc())
        total_ms = (time.perf_counter() - total_start) * 1000.0
        return JSONResponse(
            status_code=500,
            content={
                "error": str(e),
                "results": [],
                "profiling": {"total_ms": round(total_ms, 2)},
            },
        )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
