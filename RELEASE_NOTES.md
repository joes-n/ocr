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
