# QR/OCR Ticket Reader

Local ticket reader app for scanning a ticket from a webcam. The default operator flow reads a printed Micro QR code containing the seat code, then resolves seat audio from the encoded seat. The original PaddleOCR name/seat reader is still available as a separate OCR reader route.

QR tickets encode only the normalized seat value, such as `10AC13`, and are generated as SVG files. The audio buttons prefer `audio/<Seat No>_M.wav` or `audio/<Seat No>_F.wav` and fall back to `audio/<Seat No>.wav` when the gendered file is not available. In OCR reader mode, the parsed name still resolves through `names.csv` as before.

## Current Status

- Frontend: Vite + TypeScript app in `src/`
- Backend: FastAPI service in `backend/main.py`
- QR tooling: generator/decoder helpers in `backend/qr_ticket.py`
- Dev mode: Vite serves the UI and proxies `/qr`, `/ocr`, `/runtime`, `/healthz`, and `/shutdown` to `http://127.0.0.1:8000`
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
2. By default, each captured frame is uploaded to `POST /qr/decode`.
3. The backend decodes Micro QR or regular QR with zxing-cpp, falling back to OpenCV for regular QR.
4. The frontend displays the decoded seat and enables Male/Female audio buttons for that seat.
5. The preserved OCR reader is available at `/ocr-reader` or `?reader=ocr`. In that mode, continuous scan uses `POST /ocr?mode=fast`, and manual `Read Again` uses `POST /ocr?mode=accurate`.
6. The OCR reader parses OCR lines and tries to extract:
   - `holderName`
   - `seatNumber` matching `([0-9]{2}[A-Z]{2}[0-9]{2})`
7. The OCR reader normalized-exact-matches OCR name candidates against `names.csv`; `/debug` autoplays the legacy `audio/<Seat No>.wav`, while the main operator screen enables manual Male/Female buttons after a match.
8. The UI shows parsed fields, raw scan lines, diagnostics, seat-audio status, and scan state.

## QR Code Generation

Generate one Micro QR SVG:

```bash
python backend/qr_ticket.py generate --seat 10AC13 --output qr-codes/10AC13.svg
```

Generate a folder of Micro QR SVGs from `names.csv`:

```bash
python backend/qr_ticket.py batch --csv names.csv --output-dir qr-codes
```

The batch command only encodes `Seat No`; names in the CSV are ignored for QR payload size. Output filenames use the normalized seat number, for example `qr-codes/10AC13.svg`. Print the SVG at the same physical size you would have used for a normal QR code; Micro QR has fewer modules, so each module becomes larger and easier for the camera to identify. Use `--regular-qr` only if a downstream production tool cannot handle Micro QR.

From the web UI, use the top-right **Convert** button to pick a CSV file. The local backend writes SVG files to `~/Downloads/qr-codes/`, creating the folder if needed.

## Runtime Endpoints

- `POST /qr/decode`: QR request endpoint used by the default operator screen
- `POST /ocr`: preserved OCR request endpoint; accepts `mode=fast` for continuous scan or `mode=accurate` for manual fallback-capable reads
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

`npm run build:windows` runs `backend\install_runtime.py --runtime auto` before PyInstaller. On Windows machines with an NVIDIA GPU, the script installs `paddlepaddle-gpu==3.2.2` from the Paddle CUDA 12.6 package index; otherwise it installs the CPU `paddlepaddle==3.2.2` wheel. QR scanning uses OpenCV and can start before OCR models are ready. To force a runtime, run `.\packaging\windows\build.ps1 -PaddleRuntime gpu` or `.\packaging\windows\build.ps1 -PaddleRuntime cpu`. Use `-SkipRuntimeInstall` only when the virtual environment already has the intended Paddle runtime.

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
- `VITE_QR_BACKEND_URL`
- `VITE_OCR_BACKEND_URL`

Default QR backend URL is `/qr/decode`; default OCR backend URL is `/ocr`. Both work in dev mode and backend-hosted production mode.

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

`GET /runtime/status` reports `ocr_device_configured`, `ocr_device_resolved`, `paddle_cuda_compiled`, `paddle_cuda_device_count`, and `nvidia_gpu` detection details.

## NVIDIA GPU Benchmarking

The default `backend/requirements.txt` installs the CPU PaddlePaddle wheel for Docker/manual compatibility. On a Windows NVIDIA/CUDA machine, use the runtime installer to select the GPU wheel automatically:

```powershell
.\backend\.venv\Scripts\python.exe backend\install_runtime.py --runtime auto
```

For manual GPU setup or troubleshooting:

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

- QR scanning does not require `names.csv` at runtime because the QR payload includes the seat.
- Keep `names.csv` at repo root with header `Seat No,Name` for QR batch generation and the preserved OCR reader; legacy `Seat No,Chinese Name` files are still accepted.
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
- QR and OCR responses return `results`, `profiling`, `debug`, and `service_state`; `profiling.mode` reports `qr`, `fast`, or `accurate`. OCR debug data still includes `debug.label_detection.validation_attempts`.
- First launch may take longer while OCR models are downloaded or loaded.
- Write debug artifacts to `ocr_debug/` with `OCR_DEBUG_DIR=./ocr_debug OCR_DEBUG_SAVE_IMAGES=true python main.py`.
- OS-specific setup details live in `SETUP.md`.
