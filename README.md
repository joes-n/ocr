# OCR Ticket Reader

Local OCR app for scanning a ticket from a webcam, sending one captured frame to a local PaddleOCR backend, and extracting a holder name plus seat code.

When the parsed name exactly matches `Chinese Name` in `names.csv`, the frontend resolves the seat from the CSV and attempts to play `audio/<Seat No>.wav`.

## Current Status

- Frontend: Vite + TypeScript app in `src/`
- Backend: FastAPI + PaddleOCR service in `backend/main.py`
- Dev mode: Vite serves the UI and proxies `/ocr`, `/runtime`, `/healthz`, and `/shutdown` to `http://127.0.0.1:8000`
- Production-style mode: the backend serves the built frontend from `dist/`
- Browser target: desktop Chrome with camera access
- Windows packaging path: launcher + PyInstaller + Inno Setup assets in `packaging/windows/`

There is no sample ticket image checked into this repo anymore. Any backend verification command must use your own local image file.

## Repository Layout

```text
.
├── backend/
│   ├── launcher.py
│   ├── main.py
│   ├── requirements.txt
│   └── test_script.py
├── audio/
├── names.csv
├── packaging/windows/
├── src/
├── SETUP.md
├── package.json
└── vite.config.ts
```

## How It Works

1. The browser UI starts a camera preview in desktop Chrome.
2. The user captures one frame and uploads it to `POST /ocr`.
3. The backend crops the lower-left region first and runs the mobile PaddleOCR pass.
4. If the ROI pass returns nothing, the backend falls back to a full-frame server OCR pass.
5. The frontend parses OCR lines and tries to extract:
   - `holderName`
   - `seatNumber` matching `([0-9]{2}[A-Z]{2}[0-9]{2})`
6. The frontend exact-matches the parsed name against `names.csv` and tries to play `audio/<Seat No>.wav`.
7. The UI shows parsed fields, raw OCR lines, diagnostics, seat-audio status, and scan state.

## Runtime Endpoints

- `POST /ocr`: OCR request endpoint
- `GET /healthz`: lightweight process health endpoint
- `GET /runtime/status`: OCR-model readiness and packaged-app runtime state
- `POST /shutdown`: localhost-only shutdown endpoint, enabled only in packaged mode

The backend initializes PaddleOCR asynchronously. On first launch, `/runtime/status` may report `starting`, `downloading_models`, or `loading_models` before it reaches `ready`.

## Prerequisites

- Python 3.12 recommended for the backend
- Node.js 18+ and npm for the frontend/build
- Desktop Chrome for camera capture
- Optional: Docker for backend-only container runs
- Optional on Windows packaging machines: Inno Setup 6

## Developer Quick Start

### 1) Start the backend

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

### 2) Verify the backend

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

### 3) Start the frontend in dev mode

```bash
cd /home/raner/proj_ocr
npm install
npm run dev
```

Open the Vite URL shown in the terminal, typically `http://127.0.0.1:5173`, in desktop Chrome.

## Production-Style Local Run

Build the frontend, then let the backend serve `dist/` directly:

```bash
cd /home/raner/proj_ocr
npm install
npm run build

cd backend
source .venv/bin/activate
python main.py
```

Open `http://127.0.0.1:8000` in desktop Chrome.

## Windows One-Click Packaging

The packaged-app flow is built around these pieces:

- `backend/main.py`: local backend that serves the built frontend and OCR APIs
- `backend/launcher.py`: local launcher that starts the hidden backend service and opens the browser
- `packaging/windows/build.ps1`: builds the frontend, freezes the backend and launcher with PyInstaller, and optionally compiles the installer
- `packaging/windows/OCRTicketReader.iss`: Inno Setup installer definition

Typical packaging flow on Windows:

```powershell
cd C:\path\to\proj_ocr
npm install
py -3.12 -m venv backend\.venv
.\backend\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r backend\requirements.txt
pip install -r packaging\windows\requirements-packaging.txt
npm run build:windows
```

Expected outputs:

- PyInstaller bundle under `release\windows\bundle`
- Installer under `release\windows\installer` when Inno Setup 6 is installed and `ISCC.exe` is available

## Runtime Configuration

Frontend env vars are defined in `src/config.ts`:

- `VITE_CONFIDENCE_THRESHOLD_NAME`
- `VITE_CONFIDENCE_THRESHOLD_SEAT`
- `VITE_SCAN_TIMEOUT_MS`
- `VITE_RETRY_INTERVAL_MS`
- `VITE_AUDIO_PLAYBACK_RATE`
- `VITE_OCR_BACKEND_URL`

Default backend URL is `/ocr`, which works in both dev mode and backend-hosted production mode.

Useful backend env vars:

- `OCR_APP_HOST`
- `OCR_APP_PORT`
- `OCR_APP_DATA_DIR`
- `OCR_DEBUG_DIR`
- `OCR_DEBUG_SAVE_IMAGES`
- `PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK`

In packaged mode on Windows, app data defaults to `%LOCALAPPDATA%\OCRTicketReader`.

## Seat Audio Assets

- Keep `names.csv` at repo root with header `Seat No,Chinese Name`.
- Put seat WAV files in repo-root `audio/`, named exactly like the CSV seat number, for example `audio/6E53.wav`.
- If there is no CSV match or no WAV file, audio playback is skipped gracefully.

## Docker

`docker-compose.yml` only runs the backend service:

```bash
cd /home/raner/proj_ocr
docker compose up --build paddleocr-backend
```

Then run the frontend separately with `npm run dev`.

If Docker Compose cannot build images in your environment, you can build and run the backend directly:

```bash
cd /home/raner/proj_ocr
docker build -t paddleocr-backend ./backend
docker run --rm -p 8000:8000 -e PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True paddleocr-backend
```

## Notes And Limitations

- Camera capture is still intended for desktop Chrome.
- The backend currently allows CORS from any origin.
- OCR responses return `results`, `profiling`, `debug`, and `service_state`.
- First launch may take longer while OCR models are downloaded or loaded.
- Write debug artifacts to `ocr_debug/` with `OCR_DEBUG_DIR=./ocr_debug OCR_DEBUG_SAVE_IMAGES=true python main.py`.
- OS-specific setup details live in `SETUP.md`.
