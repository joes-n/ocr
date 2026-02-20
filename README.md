# OCR Ticket Reader

Desktop Chrome MVP for ticket name/seat recognition using a self-hosted PaddleOCR backend.

## Architecture
- Frontend: Vite + TypeScript webcam app.
- Backend: FastAPI + PaddleOCR (`POST /ocr`).
- Flow: camera frame -> backend OCR -> frontend parser extracts `name` and `seat`.

## Run

### 1) Start backend
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
python main.py
```

Backend runs at `http://127.0.0.1:8000`.

### 1a) Start backend with Docker
From project root:
```bash
docker compose up --build paddleocr-backend
```

Backend runs at `http://127.0.0.1:8000`.

Alternative (without Compose):
```bash
docker build -t paddleocr-backend ./backend
docker run --rm -p 8000:8000 -e PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True paddleocr-backend
```

Quick backend check:
```bash
curl -X POST http://127.0.0.1:8000/ocr \
  -F "file=@/home/raner/proj_ocr/ticket_example.jpg"
```

### 2) Start frontend
```bash
cd /home/raner/proj_ocr
npm install
npm run dev
```

Open the local Vite URL in desktop Chrome.

## Code Workflow (Scan Image -> Result on Page)
1. User opens the app and clicks **Enable Camera**.
2. Frontend (`src/main.ts`) runs `startPreview()`:
   - requests camera permission with `getUserMedia`
   - binds stream to `<video id="camera-preview">`
   - updates UI state/message to indicate preview is active
3. User frames the ticket and clicks **Capture & Send to OCR**.
4. Frontend runs `captureAndSendOCR()`:
   - captures current video frame via `captureFrameBlob()`
   - encodes frame as JPEG blob
   - posts multipart form data (`file=frame.jpg`) to `appConfig.ocrBackendUrl` (default `/ocr`)
5. Vite dev server proxies `/ocr` to backend `http://127.0.0.1:8000/ocr` (`vite.config.ts`).
6. Backend (`backend/main.py`) handles `POST /ocr` in `process_image()`:
   - decodes uploaded image with OpenCV
   - tries pink label detection (`detect_label_region`) and crops/resizes (`crop_and_resize_label`)
   - runs PaddleOCR (`ocr.predict`)
   - normalizes output to JSON lines: `[{ box, text, confidence }, ...]`
7. Frontend receives OCR lines from backend (`fetchOCRItems()`), then parses them in `parseResultFromOCRItems()`:
   - finds seat by regex `([0-9]{2}[A-Z]{2}[0-9]{2})`
   - finds name candidates from non-label text lines containing alphabetic/CJK chars
   - selects highest-confidence seat and name (excluding same line index as seat)
8. Frontend updates UI via `updateOCRDisplay()`:
   - shows parsed name/seat/confidence in **Parsed Result**
   - shows raw OCR lines in **Raw OCR**
   - updates app status (`Recognized` or `RetryNeeded`) based on confidence thresholds.

## Runtime Config (Optional)
Set with Vite env vars:
- `VITE_CONFIDENCE_THRESHOLD_NAME`
- `VITE_CONFIDENCE_THRESHOLD_SEAT`
- `VITE_SCAN_TIMEOUT_MS`
- `VITE_RETRY_INTERVAL_MS`
- `VITE_AUDIO_PLAYBACK_RATE`
- `VITE_OCR_BACKEND_URL` (recommended local dev value: `/ocr`)

## Notes
- `SOFTWARE_SPEC.md` and `tasks.md` are updated for the backend-PaddleOCR workflow.
- Current backend implementation is in `backend/main.py`.
