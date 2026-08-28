# QR/OCR Ticket Reader 0.7.0

Release date: 2026-06-29

## Highlights

- Added Micro QR and regular QR ticket scanning, with the QR reader as the default operator route.
- Preserved the PaddleOCR reader at `/ocr-reader` and `?reader=ocr`.
- Added CSV-to-QR SVG generation through the web UI and `backend/qr_ticket.py`.
- Added `POST /qr/decode` and `POST /qr/convert` backend endpoints.
- Added QR generation and decoding tests plus the required `segno` and `zxing-cpp` dependencies.
- Bumped package and installer metadata to version `0.7.0`.

## Windows Artifact

- Installer: `qr-reader-setup.exe`
- GitHub release: `https://github.com/joes-n/ocr/releases/tag/v0.7.0`
- SHA256: `5b7298dd7d73ab7bf1d0b0e788d2ca2dd26bd3b1ee5de3568234057a6330b51d`

---

# OCR Ticket Reader 0.6.0

Release date: 2026-05-29

## Highlights

- Added visible missing setup warnings on the compact operator screen when `names.csv` or seat WAV files are not available.
- Added packaged runtime checks for both `names.csv` and audio assets in developer and packaged modes.
- Fixed browser cache reuse after installing a new Windows build by opening the app with a cache-busting launch URL and serving frontend assets with no-store cache headers.
- Updated Windows packaging to detect Inno Setup 7 and generate the installer automatically.
- Improved packaging cleanup so repeated Windows rebuilds tolerate an existing generated bundle directory.
- Bumped package and installer metadata to version `0.6.0`.

## Windows Artifact

- Installer: `ocr-ticket-reader-setup.exe`
- GitHub release: `https://github.com/joes-n/ocr/releases/tag/v0.6.0`
- SHA256: `ecf382f4e02e3656cdf9709b84618591b2bd5388f5c70db65d555ed55db52158`
- Install location: `%LOCALAPPDATA%\Programs\OCRTicketReader`
- Editable setup assets: `%LOCALAPPDATA%\OCRTicketReader\assets\names.csv` and `%LOCALAPPDATA%\OCRTicketReader\assets\audio`

## Notes

- Close any already-open OCR Ticket Reader browser tab before launching the newly installed app.
- If `names.csv` or seat WAV files are missing, the operator screen now keeps the warning visible alongside scan results.
- First launch can take longer while PaddleOCR models initialize or download.
- Camera capture is still intended for desktop Chrome.

# OCR Ticket Reader 0.5.0

Release date: 2026-05-28

## Highlights

- Added automatic continuous scanning on the main operator screen.
- Split OCR requests into `fast` and `accurate` modes: continuous scan uses the faster lower-left ROI path, while manual reads keep the fallback-capable accurate path.
- Improved name matching by checking multiple OCR name candidates against `names.csv`, instead of relying only on the single parsed holder name.
- Added Male/Female seat audio controls. The app now prefers `audio/<Seat No>_M.wav` or `audio/<Seat No>_F.wav` and falls back to the legacy `audio/<Seat No>.wav`.
- Added scan latency reporting, including continuous-scan averages and matched-scan averages.
- Updated the debug comparison flow to resolve CSV matches, show parsed results, track latency, and autoplay legacy seat audio when a match is found.

## Windows Artifact

- Release ZIP: `bundle.zip`
- GitHub release: `https://github.com/joes-n/ocr/releases/tag/v0.5.0`
- SHA256: `7c6af8a9a6bcb2e142f706276c97decaac6adfc6043a4f05a9222c7ddebebf3d`
- Runnable bundle entry point: `ocr-ticket-reader.exe`
- Backend bundle: `ocr-backend`

The Inno Setup installer is not included in this build because Inno Setup 6 was not installed on the packaging machine. The PyInstaller bundle was rebuilt successfully and uploaded as `bundle.zip`.

## Notes

- Camera capture is still intended for desktop Chrome.
- First launch can take longer while PaddleOCR models initialize or download.
- For gendered seat audio, place WAV files under `audio/` using `<Seat No>_M.wav` and `<Seat No>_F.wav`; missing gendered files fall back to `<Seat No>.wav`.
- `POST /ocr` accepts `mode=fast` for continuous scans and `mode=accurate` for manual fallback-capable reads.

# OCR Ticket Reader 0.1.0

Release date: 2026-05-12

## Highlights

- Added the first Windows package for OCR Ticket Reader.
- Bundled the local FastAPI/PaddleOCR backend with a one-click launcher.
- Included the built Vite frontend so the packaged app can run locally without a separate dev server.
- The Windows launcher opens a live backend log window for startup, model loading, and OCR diagnostics.
- Added packaged runtime asset handling for `names.csv` and seat audio files, with editable copies stored under `%LOCALAPPDATA%\OCRTicketReader\assets`.
- Added runtime status and shutdown endpoints used by the packaged launcher flow.

## Windows Artifact

- Release ZIP: `release\windows\ocr-ticket-reader-0.1.0-windows.zip`
- Runnable bundle: `release\windows\bundle`
- Launcher executable: `release\windows\bundle\ocr-ticket-reader.exe`
- Backend bundle: `release\windows\bundle\ocr-backend`

The Inno Setup installer is not included in this build because Inno Setup 6 was not installed on the packaging machine. Installing Inno Setup 6 and rerunning `npm run build:windows` will produce `release\windows\installer\ocr-ticket-reader-setup.exe`.

## Notes

- First launch can take longer while PaddleOCR models initialize or download.
- Camera capture is intended for desktop Chrome.
- Seat audio playback requires `names.csv` with `Seat No,Name` and matching `.wav` files named by seat number.
