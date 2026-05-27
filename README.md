# OCR Ticket Reader

Local OCR app for scanning a ticket from a webcam, sending one captured frame to a local PaddleOCR backend, and extracting a holder name plus seat code.

When the parsed name matches `Name` in `names.csv`, the frontend resolves the seat from the CSV and enables Male/Female audio buttons. The buttons prefer `audio/<Seat No>_M.wav` or `audio/<Seat No>_F.wav` and fall back to `audio/<Seat No>.wav` when the gendered file is not available.

## Current Status

- Frontend: Vite + TypeScript app in `src/`
- Backend: FastAPI + PaddleOCR service in `backend/main.py`
- Dev mode: Vite serves the UI and proxies `/ocr`, `/runtime`, `/healthz`, and `/shutdown` to `http://127.0.0.1:8000`
- Production-style mode: the backend serves the built frontend from `dist/` and serves `names.csv`/`audio/` from the repo root
- Browser target: desktop Chrome with camera access
- Scan modes: one-click capture and continuous 1-second capture
- Windows packaging path: launcher + PyInstaller + Inno Setup assets in `packaging/windows/`

Example JPEGs are checked in for OCR smoke tests and timing runs: `text_line_*.jpg` and `ticket_example.jpg`. Use real local captures for production verification.

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
2. The user captures one frame on demand or enables continuous 1-second capture, and each frame is uploaded to `POST /ocr`.
3. The backend crops the lower-left region first and runs the mobile PaddleOCR pass.
4. If the ROI pass returns nothing, the backend falls back to a full-frame server OCR pass.
5. The frontend parses OCR lines and tries to extract:
   - `holderName`
   - `seatNumber` matching `([0-9]{2}[A-Z]{2}[0-9]{2})`
6. The frontend normalized-exact-matches the parsed name against `names.csv` and enables manual Male/Female audio playback. In `/debug`, OCR still autoplays the legacy `audio/<Seat No>.wav`.
7. The UI shows parsed fields, raw OCR lines, diagnostics, seat-audio status, and scan state.

## Runtime Endpoints

- `POST /ocr`: OCR request endpoint
- `GET /healthz`: lightweight process health endpoint
- `GET /runtime/status`: OCR-model readiness, packaged-app runtime state, and seat-asset paths
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

Open `/debug` in the browser for the comparison page. The page posts captured frames to `/debug/compare`, which compares the current bottom-left ROI det+rec path against the TextDetection -> crop -> TextRecognition path.

```bash
curl -X POST http://127.0.0.1:8000/debug/compare \
  -F "file=@/absolute/path/to/your-image.jpg"
```

For a labeled accuracy pass, keep ticket captures outside the repo and create a JSON or CSV manifest with image path, expected name, and expected seat:

```json
[
  {
    "image": "/absolute/path/to/ticket.jpg",
    "expected_name": "Jane Chan",
    "expected_seat": "10AC13"
  }
]
```

Then run:

```bash
cd /home/raner/proj_ocr
python backend/evaluate_ocr.py /absolute/path/to/manifest.json --fail-on-miss
```

For a repeatable timing pass on the checked-in example images:

```bash
cd /home/raner/proj_ocr
python backend/benchmark_examples.py --device cpu --loops 3
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
- `OCR_DEVICE`: `auto`, `cpu`, `gpu`, or `gpu:<index>`; default is `auto`
- `OCR_DEBUG_DIR`
- `OCR_DEBUG_SAVE_IMAGES`
- `PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK`

In packaged mode on Windows, app data defaults to `%LOCALAPPDATA%\OCRTicketReader`.

`OCR_DEVICE=auto` uses `gpu:0` only when the installed PaddlePaddle package is CUDA-enabled and at least one CUDA device is visible. Otherwise it falls back to CPU. `OCR_DEVICE=gpu:0` is strict and startup fails if CUDA is unavailable. CPU inference keeps MKL-DNN enabled; GPU inference disables MKL-DNN.

`GET /runtime/status` reports `ocr_device_configured`, `ocr_device_resolved`, `paddle_cuda_compiled`, and `paddle_cuda_device_count`.

## NVIDIA GPU Benchmarking

The default `backend/requirements.txt` installs the CPU PaddlePaddle wheel. On an NVIDIA/CUDA machine, replace it with the GPU wheel before using `OCR_DEVICE=gpu:0`.

```bash
nvidia-smi
python -m pip uninstall -y paddlepaddle paddlepaddle-gpu
python -m pip install paddlepaddle-gpu==3.2.2 -i https://www.paddlepaddle.org.cn/packages/stable/cu126/
python -c "import paddle; print(paddle.__version__, paddle.is_compiled_with_cuda(), paddle.device.cuda.device_count()); paddle.utils.run_check()"
```

Use the `cu118`, `cu126`, or `cu129` PaddlePaddle package index that matches the target driver/runtime. See the official PaddlePaddle and PaddleOCR install docs for the current wheel matrix:

- https://www.paddlepaddle.org.cn/documentation/docs/install/pip/windows-pip_en.html
- https://www.paddleocr.ai/latest/en/version3.x/paddlepaddle_installation.html

Then compare the same images and model flow:

```bash
python backend/benchmark_examples.py --device cpu --loops 3 --json-output cpu-benchmark.json
python backend/benchmark_examples.py --device gpu:0 --loops 3 --json-output gpu-benchmark.json
```

For the app itself:

```bash
OCR_DEVICE=gpu:0 python backend/main.py
```

## Seat Audio Assets

- Keep `names.csv` at repo root with header `Seat No,Name`; legacy `Seat No,Chinese Name` files are still accepted.
- Put seat WAV files in repo-root `audio/`. Gendered files should be named like `audio/6E53_M.wav` and `audio/6E53_F.wav`; if either is missing, that button falls back to the legacy `audio/6E53.wav`.
- In the packaged Windows app, editable runtime copies live under `%LOCALAPPDATA%\OCRTicketReader\assets`.
- On first packaged launch, bundled starter assets are copied there only when the destination file is missing.
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
- OCR responses return `results`, `profiling`, `debug`, and `service_state`; `debug.label_detection.validation_attempts` lists the ROI/fallback candidates that were scored.
- First launch may take longer while OCR models are downloaded or loaded.
- Write debug artifacts to `ocr_debug/` with `OCR_DEBUG_DIR=./ocr_debug OCR_DEBUG_SAVE_IMAGES=true python main.py`.
- OS-specific setup details live in `SETUP.md`.
