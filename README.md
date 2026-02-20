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

## Runtime Config (Optional)
Set with Vite env vars:
- `VITE_CONFIDENCE_THRESHOLD_NAME`
- `VITE_CONFIDENCE_THRESHOLD_SEAT`
- `VITE_SCAN_TIMEOUT_MS`
- `VITE_RETRY_INTERVAL_MS`
- `VITE_AUDIO_PLAYBACK_RATE`
- `VITE_OCR_BACKEND_URL` (recommended default: `http://127.0.0.1:8000/ocr`)

## Notes
- `SOFTWARE_SPEC.md` and `tasks.md` are updated for the backend-PaddleOCR workflow.
- Current backend implementation is in `backend/main.py`.
