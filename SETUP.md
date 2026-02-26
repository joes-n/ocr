# SETUP

This file is the current setup source of truth for this repository.

## Setup Guide

This project has two parts:
- Backend: FastAPI + PaddleOCR (`http://127.0.0.1:8000`)
- Frontend: Vite app (`http://127.0.0.1:5173` by default)

### Prerequisites

- Python 3.11 recommended
- Node.js 18+ and npm
- Desktop Chrome (camera permission is required for scanning)

Optional:
- Docker (only if you want to run backend in a container)

## Linux

### 1) Start backend

```bash
cd /home/raner/proj_ocr/backend
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
export PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
python main.py
```

Backend should be available at `http://127.0.0.1:8000`.

### 2) Verify backend

Open a second terminal:

```bash
curl -X POST http://127.0.0.1:8000/ocr \
  -F "file=@/home/raner/proj_ocr/ticket_example.jpg"
```

A JSON OCR response means backend is working.

### 3) Start frontend

Open a third terminal:

```bash
cd /home/raner/proj_ocr
npm install
npm run dev
```

Open the Vite URL shown in terminal (typically `http://127.0.0.1:5173`) in desktop Chrome.

## Windows (PowerShell)

### 1) Start backend

```powershell
cd C:\path\to\proj_ocr\backend
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
$env:PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK="True"
python main.py
```

Backend should be available at `http://127.0.0.1:8000`.

### 2) Verify backend

Open a second PowerShell window:

```powershell
curl.exe -X POST http://127.0.0.1:8000/ocr -F "file=@C:\path\to\proj_ocr\ticket_example.jpg"
```

A JSON OCR response means backend is working.

### 3) Start frontend

Open a third PowerShell window:

```powershell
cd C:\path\to\proj_ocr
npm install
npm run dev
```

Open the Vite URL shown in terminal (typically `http://127.0.0.1:5173`) in desktop Chrome.

## Windows (CMD)

### 1) Start backend

```bat
cd C:\path\to\proj_ocr\backend
py -3.11 -m venv .venv
.\.venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt
set PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
python main.py
```

### 2) Verify backend

Open a second CMD window:

```bat
curl -X POST http://127.0.0.1:8000/ocr -F "file=@C:\path\to\proj_ocr\ticket_example.jpg"
```

### 3) Start frontend

Open a third CMD window:

```bat
cd C:\path\to\proj_ocr
npm install
npm run dev
```

Open the Vite URL shown in terminal (typically `http://127.0.0.1:5173`) in desktop Chrome.

## Optional: Backend with Docker

From repo root:

```bash
docker compose up --build paddleocr-backend
```

Then run frontend with:

```bash
npm run dev
```

## Troubleshooting

- If frontend cannot reach OCR, confirm backend is running on port `8000`.
- If camera preview fails, use desktop Chrome and allow camera access.
- If Python package installation fails on Windows, ensure you are using Python 3.11 and an activated virtual environment.
