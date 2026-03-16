# OCR Ticket Reader

Browser-based MVP for capturing a ticket image from a webcam, sending it to a local OCR backend, and extracting a holder name plus seat code.

## Current State

- Frontend: Vite + TypeScript app in `src/`
- Backend: FastAPI + PaddleOCR service in `backend/main.py`
- Dev proxy: Vite forwards `/ocr` to `http://127.0.0.1:8000` in `vite.config.ts`
- Browser target: desktop Chrome with camera access

There is no sample ticket image checked into this repo anymore. Any backend verification command must use your own local image file.

## Repository Layout

```text
.
├── backend/
│   ├── main.py
│   ├── requirements.txt
│   └── test_script.py
├── src/
│   ├── main.ts
│   ├── config.ts
│   ├── scan-controller.ts
│   ├── styles.css
│   └── types.ts
├── docker-compose.yml
├── SETUP.md
├── package.json
└── vite.config.ts
```

## How It Works

1. The frontend starts a camera preview in desktop Chrome.
2. The user captures a frame and uploads it to `POST /ocr`.
3. The backend decodes the image and looks for a pink/salmon ticket label.
4. If a label is found, the backend crops it, segments text lines with OpenCV, and runs Paddle `TextRecognition` on each line.
5. If label detection or line segmentation fails, the backend falls back to full `PaddleOCR`.
6. The frontend parses OCR lines and tries to extract:
   - `holderName`
   - `seatNumber` matching `([0-9]{2}[A-Z]{2}[0-9]{2})`
7. The UI shows parsed fields, raw OCR lines, and scan state (`Ready`, `Scanning`, `Recognized`, `RetryNeeded`).

## Prerequisites

- Python 3.11 recommended for the backend
- Node.js 18+ and npm for the frontend
- Desktop Chrome for camera capture
- Optional: Docker, if you want to run only the backend in a container

## Quick Start

### Backend

```bash
cd /home/raner/proj_ocr/backend
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
export PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
python main.py
```

Backend URL: `http://127.0.0.1:8000`

### Backend Verification

Use any local ticket image:

```bash
curl -X POST http://127.0.0.1:8000/ocr \
  -F "file=@/absolute/path/to/your-image.jpg"
```

Or with the helper script:

```bash
cd /home/raner/proj_ocr/backend
python test_script.py /absolute/path/to/your-image.jpg
```

### Frontend

```bash
cd /home/raner/proj_ocr
npm install
npm run dev
```

Open the Vite URL shown in the terminal, typically `http://127.0.0.1:5173`, in desktop Chrome.

## Docker

`docker-compose.yml` only runs the backend service:

```bash
cd /home/raner/proj_ocr
docker compose up --build paddleocr-backend
```

Then start the frontend separately with `npm run dev`.

If your Docker installation cannot build through Compose, you can build and run the backend directly:

```bash
cd /home/raner/proj_ocr
docker build -t paddleocr-backend ./backend
docker run --rm -p 8000:8000 -e PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True paddleocr-backend
```

## Runtime Configuration

Frontend env vars are defined in `src/config.ts`:

- `VITE_CONFIDENCE_THRESHOLD_NAME`
- `VITE_CONFIDENCE_THRESHOLD_SEAT`
- `VITE_SCAN_TIMEOUT_MS`
- `VITE_RETRY_INTERVAL_MS`
- `VITE_AUDIO_PLAYBACK_RATE`
- `VITE_OCR_BACKEND_URL`

Default backend URL is `/ocr`, which works with the Vite dev proxy.

## Notes And Limitations

- The frontend also supports camera selection and front/rear switching when the browser exposes those devices.
- The backend currently allows CORS from any origin.
- OCR responses return `results` plus a `profiling` object.
- OS-specific setup examples live in `SETUP.md`.
- Write test results to ocr_debug/ by OCR_DEBUG_DIR=./ocr_debug OCR_DEBUG_SAVE_IMAGES=true python main.py
