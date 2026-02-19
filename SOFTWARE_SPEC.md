# OCR Ticket Reader Web App - Software Specification (MVP)

## 1. Document Control
- Version: 1.1
- Date: 2026-02-20
- Status: Active implementation spec
- Product Name: OCR Ticket Reader Web App

## 2. Purpose and Goals
Build a browser-based application for laptop use that:
- Reads a ticket through webcam input.
- Uses a self-hosted PaddleOCR backend to recognize text from captured frames.
- Parses OCR text to extract the ticket holder full name and seat number.
- Displays name and seat number on screen.
- Reads name and seat number aloud.

Primary success goal:
- End-to-end processing time from stable ticket placement to spoken output is under 1 second in ideal conditions.

## 3. Users and Operating Context
- Primary users: Ticket holders.
- Usage context: Ticket presented to laptop webcam.
- Input orientation: Ticket may be rotated and partially skewed.
- Environment assumptions for MVP:
  - HD camera available.
  - Ticket text area is visible and in focus.
  - Good-enough lighting for OCR.
  - Single ticket shown at a time.

## 4. Scope
### 4.1 In Scope (MVP)
- Real-time webcam capture in browser (Chrome desktop target).
- Frame submission to a local/self-hosted OCR backend (`POST /ocr`).
- OCR and extraction of:
  - Holder full name (Chinese or English).
  - Seat number matching `NNLLNN` (example `10AC13`).
- Parser-based field extraction from full-frame OCR results (no fixed ROI dependency).
- On-screen result display with confidence checks.
- Audio output:
  - Prefer pre-recorded audio for name and seat.
  - Fallback to TTS when pre-recorded audio is unavailable.
- Low-confidence handling:
  - Prompt user to reposition ticket.
  - Retry automatically.

### 4.2 Out of Scope
- External OCR SaaS/API providers.
- Native mobile apps.
- Multi-template model training.
- Database-backed persistence.
- Advanced privacy/compliance hardening beyond MVP defaults.

## 5. Functional Requirements
### FR-1 Webcam Input
- The app shall request webcam permission in Chrome.
- The app shall show a live preview.
- The app shall continuously sample frames while scanning is active.

### FR-2 OCR Backend Invocation
- The app shall submit sampled frames to a self-hosted backend OCR endpoint.
- The backend shall run PaddleOCR locally and return recognized text items with bounding boxes and confidence.
- The backend endpoint shall be `POST /ocr` with multipart field name `file`.

### FR-3 Field Parsing and Validation
- The app shall parse backend OCR output to extract:
  - Holder full name (Chinese or English).
  - Seat number matching regex `^[0-9]{2}[A-Z]{2}[0-9]{2}$`.
- The app shall reject seat strings not matching the format.
- The app shall tolerate OCR noise and choose the best candidate set by parser rules.

### FR-4 OCR Engine Constraint
- OCR shall run with no third-party OCR service provider dependency.
- OCR engine shall be self-hosted PaddleOCR in project-controlled runtime.

### FR-5 Output Rendering
- The app shall display recognized name and seat number.
- The app shall display a confidence indicator for each extracted field.

### FR-6 Audio Output
- For name:
  - Use pre-recorded audio if exact match exists.
  - Otherwise use TTS fallback.
- For seat:
  - Use pre-recorded audio if available.
  - Otherwise use TTS fallback.
- Audio sequence shall read name first, then seat number.

### FR-7 Low Confidence Flow
- If confidence is below configured threshold:
  - App shall prompt user to reposition ticket.
  - App shall retry capture and OCR automatically.
  - App shall avoid speaking uncertain outputs.

## 6. Non-Functional Requirements
### NFR-1 Performance
- In ideal conditions, from stable ticket placement to spoken output shall be < 1 second (p95).
- OCR + parsing pipeline shall prioritize low latency for MVP.

### NFR-2 Accuracy
- Under good lighting and focus, name + seat extraction success rate shall be > 95%.

### NFR-3 Platform
- MVP browser support: Google Chrome (desktop).
- MVP backend runtime: local/self-hosted Python service.

### NFR-4 Availability/Security/Privacy
- No explicit production-grade targets defined for MVP.

## 7. Data and Storage
### 7.1 Persistent Data
- No database required for MVP.

### 7.2 Runtime Data
- Temporary in-memory OCR results and confidence scores.
- Parsed name/seat candidates and final selected values.
- Mapping of pre-recorded audio file names:
  - Name audio file mapped to holder name key.
  - Seat audio file mapped to seat key.

### 7.3 Logging
- Minimal local diagnostic logs for backend and frontend.
- Error logs retained only in process output unless explicit persistence is added.

## 8. High-Level Architecture (Selected)
Single architecture mode for MVP:
1. Browser captures camera frames.
2. Browser uploads frame to self-hosted backend (`/ocr`).
3. Backend runs PaddleOCR and returns text lines + confidence + polygons.
4. Frontend parser derives `name` and `seat` from OCR results.
5. Frontend validates seat regex and confidence thresholds.
6. Frontend renders and plays audio (pre-recorded first, TTS fallback).

Constraint:
- No external OCR SaaS/API provider.

## 9. Processing Pipeline (Normative)
1. Start scan and open webcam stream.
2. Capture frame at configured interval.
3. Send frame to backend `/ocr`.
4. Backend runs PaddleOCR and returns OCR items.
5. Parse OCR items into `name` and `seat` candidates.
6. Validate seat with regex `^[0-9]{2}[A-Z]{2}[0-9]{2}$`.
7. Compute per-field and combined confidence.
8. If confidence passes:
   - Render text.
   - Resolve audio files.
   - Play pre-recorded clips or TTS fallback.
9. If confidence fails:
   - Show reposition prompt.
   - Retry automatically.

## 10. UX Requirements
- Clear camera preview with concise scan status.
- Simple states:
  - Ready
  - Scanning
  - Recognized
  - Retry needed
- Display recognized text before/while speaking.
- Retry prompt shall be actionable and concise.

## 11. Configuration Parameters
- `confidence_threshold_name`
- `confidence_threshold_seat`
- `scan_timeout_ms`
- `retry_interval_ms`
- `audio_playback_rate`
- `seat_regex` fixed to `^[0-9]{2}[A-Z]{2}[0-9]{2}$` for MVP
- `ocr_backend_url` (default `http://127.0.0.1:8000/ocr`)

## 12. Acceptance Criteria (MVP)
### AC-1 Core Recognition
- Given a valid ticket in good lighting and focus,
- When user places it under webcam,
- Then app extracts full name and seat number correctly from backend OCR output.

### AC-2 Seat Format Enforcement
- Given OCR output not matching `NNLLNN`,
- When validation runs,
- Then app does not accept seat value and requests retry.

### AC-3 Audio Priority and Fallback
- Given recognized name/seat with available pre-recorded audio,
- Then app plays pre-recorded audio.
- Given audio file missing for either field,
- Then app uses TTS for the missing segment.

### AC-4 Low Confidence Handling
- Given field confidence below threshold,
- Then app shows reposition prompt and retries automatically.

### AC-5 Performance
- Given ideal environment,
- Then p95 end-to-end latency is < 1 second.

### AC-6 Browser Target
- MVP behavior is validated on desktop Chrome with local backend running.

## 13. Test Plan Summary
### 13.1 Functional Tests
- Backend `/ocr` returns text items from uploaded image.
- Parser extracts correct name/seat from realistic OCR noise.
- Mixed language names (Chinese and English).
- Seat validation positive and negative cases.
- Audio playback path for:
  - pre-recorded exists
  - pre-recorded missing -> TTS fallback
- Low-confidence prompt and retry behavior.

### 13.2 Performance Tests
- Measure p50/p95 latency from stable frame to first audio output.
- Include backend OCR latency in total measurement.

### 13.3 Accuracy Tests
- Evaluate extraction success over representative ticket set.
- Pass criterion: >95% name+seat correctness in ideal conditions.

## 14. Risks and Mitigations
- OCR confusion for similar characters (`O/0`, `I/1`, `B/8`)
  - Mitigation: strict seat regex + parser normalization + confidence gating.
- Backend latency spikes or process memory pressure on high-resolution frames
  - Mitigation: resize input before OCR and tune sampling interval.
- Name extraction ambiguity in noisy OCR output
  - Mitigation: parser ranking heuristics and fallback retry prompt.

## 15. Open Implementation Decisions
- Final parser ranking logic for choosing best name candidate.
- Final confidence aggregation formula across OCR lines.
- Final list and naming convention for pre-recorded audio assets.
- Final calibration values for retry interval and confidence thresholds.

## 16. Definition of Done (MVP)
- All acceptance criteria in Section 12 pass on Chrome desktop with backend running.
- Accuracy and latency targets are met in defined ideal test environment.
- User can complete full flow: place ticket -> see result -> hear result.
