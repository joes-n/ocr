# OCR Ticket Reader

MVP scaffold for a desktop Chrome web app.

## Run
1. `npm install`
2. `npm run dev`
3. Open the local URL in desktop Chrome.

## Current Status
- `T-001` initialized project scaffold.
- `T-002` added typed runtime config module in `src/config.ts`.
- `T-003` added shared interfaces in `src/types.ts`.
- `T-010` implemented webcam permission request and live camera preview.
- `T-011` implemented scan state controller in `src/scan-controller.ts`.
- `T-012` added configurable frame sampling loop with start/stop lifecycle handling.
- `T-020` added in-frame known-template ticket localization and live overlay.
- `T-021` implemented orientation normalization to canonical ticket view in `src/ticket-normalizer.ts`.
- `T-022` implemented extraction of name and seat ROIs from normalized ticket coordinates in `src/ticket-roi.ts`.
- Webcam, OCR, validation, and audio flow are implemented in later tasks.

## Runtime Config (Optional)
Set with Vite env vars:
- `VITE_CONFIDENCE_THRESHOLD_NAME`
- `VITE_CONFIDENCE_THRESHOLD_SEAT`
- `VITE_SCAN_TIMEOUT_MS`
- `VITE_RETRY_INTERVAL_MS`
- `VITE_AUDIO_PLAYBACK_RATE`
