from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import logging
import traceback
import cv2
import numpy as np

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

logger.info("Initializing PaddleOCR...")
import os

os.environ["FLAGS_allocator_strategy"] = "auto_growth"
os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
from paddleocr import PaddleOCR

# Use mobile (lightweight) models for speed.  The cropped label has large, clear
# text so mobile-grade accuracy is more than sufficient.  Disable document
# orientation classification and unwarping since we feed a pre-cropped label.
ocr = PaddleOCR(
    text_detection_model_name="PP-OCRv5_mobile_det",
    text_recognition_model_name="PP-OCRv5_mobile_rec",
    use_doc_orientation_classify=False,
    use_doc_unwarping=False,
    use_textline_orientation=False,
    enable_mkldnn=False,
)
logger.info("PaddleOCR initialized.")

MAX_IMAGE_SIDE = 1920
LABEL_MAX_SIDE = 640

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
LABEL_CROP_PAD = 0.10  # 10% padding around detected bbox


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


def crop_and_resize_label(img: np.ndarray, bbox) -> np.ndarray:
    """Crop image to label bbox with padding, then resize for fast OCR."""
    x, y, w, h = bbox
    img_h, img_w = img.shape[:2]

    pad_x = int(w * LABEL_CROP_PAD)
    pad_y = int(h * LABEL_CROP_PAD)
    x1 = max(0, x - pad_x)
    y1 = max(0, y - pad_y)
    x2 = min(img_w, x + w + pad_x)
    y2 = min(img_h, y + h + pad_y)

    crop = img[y1:y2, x1:x2]

    crop_h, crop_w = crop.shape[:2]
    longest = max(crop_h, crop_w)
    if longest > LABEL_MAX_SIDE:
        scale = LABEL_MAX_SIDE / float(longest)
        crop = cv2.resize(
            crop,
            (max(1, int(crop_w * scale)), max(1, int(crop_h * scale))),
            interpolation=cv2.INTER_AREA,
        )

    return crop


@app.post("/ocr")
async def process_image(file: UploadFile = File(...)):
    logger.info("Received request /ocr")
    try:
        contents = await file.read()
        nparr = np.frombuffer(contents, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if img is None:
            raise ValueError("Unable to decode image from upload")

        # Try to detect and crop the pink name label for faster OCR.
        bbox = detect_label_region(img)
        if bbox is not None:
            x, y, w, h = bbox
            logger.info(f"Label detected at ({x},{y},{w},{h}), cropping")
            img = crop_and_resize_label(img, bbox)
        else:
            # Fallback: resize the full image (original behaviour).
            logger.info("Label not detected, using full-frame fallback")
            height, width = img.shape[:2]
            longest_side = max(height, width)
            if longest_side > MAX_IMAGE_SIDE:
                scale = MAX_IMAGE_SIDE / float(longest_side)
                resized_width = max(1, int(width * scale))
                resized_height = max(1, int(height * scale))
                img = cv2.resize(
                    img, (resized_width, resized_height), interpolation=cv2.INTER_AREA
                )

        logger.info(f"OCR input size: {img.shape[1]}x{img.shape[0]}")
        result = list(ocr.predict(img))

        output = []
        for page in result:
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
                continue

            # Backward compatibility for older tuple/list output.
            if isinstance(page, list):
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
        return {"results": output}
    except Exception as e:
        logger.error(f"Error processing image: {e}")
        logger.error(traceback.format_exc())
        return JSONResponse(
            status_code=500,
            content={"error": str(e), "results": []},
        )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
