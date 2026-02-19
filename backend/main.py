from fastapi import FastAPI, UploadFile, File
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
from paddleocr import PaddleOCR
ocr = PaddleOCR(
    use_textline_orientation=True,
    lang="ch",
    enable_mkldnn=False,
)
logger.info("PaddleOCR initialized.")

MAX_IMAGE_SIDE = 1920

@app.post("/ocr")
async def process_image(file: UploadFile = File(...)):
    logger.info("Received request /ocr")
    try:
        contents = await file.read()
        nparr = np.frombuffer(contents, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if img is None:
            raise ValueError("Unable to decode image from upload")

        height, width = img.shape[:2]
        longest_side = max(height, width)
        if longest_side > MAX_IMAGE_SIDE:
            scale = MAX_IMAGE_SIDE / float(longest_side)
            resized_width = max(1, int(width * scale))
            resized_height = max(1, int(height * scale))
            img = cv2.resize(img, (resized_width, resized_height), interpolation=cv2.INTER_AREA)

        result = list(ocr.predict(img, use_textline_orientation=True))

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
        return {"error": str(e), "results": []}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
