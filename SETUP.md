# SETUP

This file is the setup reference for this repository.

## Setup Modes

This project now supports three practical ways to run it:

- Developer mode: run the backend on `127.0.0.1:8000` and Vite on `127.0.0.1:5173`
- Production-style local mode: build the frontend and let the backend serve `dist/` on `127.0.0.1:8000`
- Windows packaged mode: build a launcher + frozen backend + installer from `packaging/windows/`

## Prerequisites

- Python 3.11 recommended
- Node.js 18+ and npm
- Desktop Chrome with camera permission for scanning
- Optional: Docker for backend-only runs
- Optional on Windows packaging machines: Inno Setup 6

Important:

- This repo does not include a sample ticket image anymore.
- For backend verification, replace the example image path below with a real local image on your machine.
- On first backend startup, OCR model initialization may take a while.

## Linux Or macOS Developer Mode

### 1) Create the backend environment

```bash
cd /home/raner/proj_ocr/backend
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
export PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
```

### 2) Start the backend

```bash
cd /home/raner/proj_ocr/backend
source .venv/bin/activate
python main.py
```

Backend should be available at `http://127.0.0.1:8000`.

### 3) Verify backend readiness

The process can be up before OCR is fully ready. Check:

```bash
curl http://127.0.0.1:8000/runtime/status
```

Wait until `"state": "ready"` before testing OCR.

### 4) Verify OCR manually

```bash
curl -X POST http://127.0.0.1:8000/ocr \
  -F "file=@/absolute/path/to/your-image.jpg"
```

Or:

```bash
cd /home/raner/proj_ocr/backend
source .venv/bin/activate
python test_script.py /absolute/path/to/your-image.jpg
```

### 5) Start the frontend in dev mode

```bash
cd /home/raner/proj_ocr
npm install
npm run dev
```

Open the Vite URL shown in terminal, typically `http://127.0.0.1:5173`, in desktop Chrome.

## Windows Developer Mode (PowerShell)

### 1) Create the backend environment

```powershell
cd C:\path\to\proj_ocr\backend
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
$env:PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK="True"
```

### 2) Start the backend

```powershell
cd C:\path\to\proj_ocr\backend
.\.venv\Scripts\Activate.ps1
python main.py
```

Backend should be available at `http://127.0.0.1:8000`.

### 3) Check runtime status

```powershell
curl.exe http://127.0.0.1:8000/runtime/status
```

Wait until `"state": "ready"` before testing OCR.

### 4) Verify OCR manually

```powershell
curl.exe -X POST http://127.0.0.1:8000/ocr -F "file=@C:\path\to\your-image.jpg"
```

### 5) Start the frontend in dev mode

```powershell
cd C:\path\to\proj_ocr
npm install
npm run dev
```

Open the Vite URL shown in terminal, typically `http://127.0.0.1:5173`, in desktop Chrome.

## Production-Style Local Mode

Use this when you want the backend to serve the built frontend directly instead of running Vite.

### 1) Build the frontend

```bash
cd /home/raner/proj_ocr
npm install
npm run build
```

### 2) Start the backend

```bash
cd /home/raner/proj_ocr/backend
source .venv/bin/activate
python main.py
```

### 3) Open the app

Open `http://127.0.0.1:8000` in desktop Chrome.

The backend will serve `dist/`, `names.csv`, and `audio/` assets from the built app output.

## Windows Packaged Build

This produces the one-click Windows app path that the repo now targets.

### 1) Prepare Python and packaging tools

```powershell
cd C:\path\to\proj_ocr
py -3.11 -m venv backend\.venv
.\backend\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r backend\requirements.txt
pip install -r packaging\windows\requirements-packaging.txt
```

### 2) Build the Windows bundle

```powershell
cd C:\path\to\proj_ocr
npm install
npm run build:windows
```

The PowerShell build script:

- builds the frontend
- freezes `backend/main.py` as `ocr-backend`
- freezes `backend/launcher.py` as `ocr-ticket-reader.exe`
- bundles both under `release\windows\bundle`
- compiles the installer when Inno Setup 6 is installed

### 3) Expected outputs

- `release\windows\bundle`
- `release\windows\installer\ocr-ticket-reader-setup.exe` when `ISCC.exe` is available

### 4) Packaged app behavior

- The launcher starts the backend on `127.0.0.1:38451`
- The backend serves the built frontend and OCR APIs from the same origin
- The browser opens automatically once `GET /healthz` responds
- The UI polls `GET /runtime/status` until OCR reaches `ready`
- Packaged app data defaults to `%LOCALAPPDATA%\OCRTicketReader`

## Optional: Backend with Docker

From repo root:

```bash
docker compose up --build paddleocr-backend
```

Then run the frontend separately with:

```bash
npm run dev
```

If Docker Compose cannot build images in your environment, you can use plain Docker instead:

```bash
docker build -t paddleocr-backend ./backend
docker run --rm -p 8000:8000 -e PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True paddleocr-backend
```

## Troubleshooting

- If the browser UI says the runtime is still starting, check `GET /runtime/status` and wait for `"state": "ready"`.
- If frontend requests fail in dev mode, confirm the backend is running on port `8000`.
- If production-style local mode serves a 404 at `/`, run `npm run build` first so `dist/` exists.
- If camera preview fails, use desktop Chrome and allow camera access.
- If Python package installation fails on Windows, confirm Python 3.11 and an activated virtual environment.
- If packaged startup fails on Windows, inspect `%LOCALAPPDATA%\OCRTicketReader\logs\backend.log`.
- If backend verification fails, confirm the image path points to a real local file.
- If `docker compose build` fails early, check whether your Docker install includes Compose build support or use the plain `docker build` fallback.
