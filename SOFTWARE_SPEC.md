# OCR Ticket Reader Web App - Software Specification (MVP)

## 1. Document Control
- Version: 1.0
- Date: 2026-02-14
- Status: Draft for implementation
- Product Name: OCR Ticket Reader Web App

## 2. Purpose and Goals
Build a browser-based application for laptop use that:
- Reads a ticket through webcam input.
- Extracts the ticket holder's full name and seat number.
- Displays name and seat number on screen.
- Reads name and seat number aloud.

Primary success goal:
- End-to-end processing time from ticket placement to spoken output is under 1 second in ideal conditions.

## 3. Users and Operating Context
- Primary users: Ticket holders.
- Usage context: Ticket presented to laptop webcam.
- Input orientation: Ticket may be placed a +45/-45 degrees to horizontal orientation.
- Environment assumptions for MVP:
  - HD camera available.
  - Part of ticket might be under shadow. White label will not be under shadow.
  - Ticket in focus and within optimal distance.
  - Known single ticket template.
  - Part of ticket might be blocked buy user hand. The entire white label is always visible.
  - The ticket might be wrinkled.

## 4. Scope
### 4.1 In Scope (MVP)
- Real-time webcam capture in browser (Chrome only).
- Detection and OCR of ticket holder full name (Chinese or English).
- Detection and OCR of seat number pattern.
- Seat number format validation: `NNLLNN` (2 digits + 2 letters + 2 digits), example `10AC13`.
- Handling ticket rotation for OCR success.
- On-screen result display with confidence checks.
- Audio output:
  - Prefer pre-recorded audio for name and seat.
  - Fallback to TTS when pre-recorded audio is unavailable.
- Low-confidence handling:
  - Prompt user to reposition ticket.
  - Retry automatically.

### 4.2 Out of Scope
- Use of external OCR service providers.
- Native mobile apps.
- Multi-template ticket support.
- Security/privacy/compliance hardening beyond standard browser/runtime defaults.
- Database-backed persistence.

## 5. Functional Requirements
### FR-1 Webcam Input
- The app shall request webcam permission in Chrome.
- The app shall show a live preview.
- The app shall continuously process frames while scanning is active.

### FR-2 Ticket Localization and Orientation Handling
- The app shall locate the known ticket template in frame.
- The app shall normalize orientation for OCR when ticket is rotated.

### FR-3 Field Extraction
- The app shall extract:
  - Holder full name (Chinese or English).
  - Seat number matching `NNLLNN`.
- The app shall reject seat strings not matching the format.

### FR-4 OCR Engine Constraint
- OCR shall run with no third-party OCR service provider dependency.
- OCR implementation may be:
  - Fully local in browser, or
  - Self-hosted backend OCR service controlled by project owner.

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
- Audio sequence shall read name then seat number.

### FR-7 Low Confidence Flow
- If confidence is below configured threshold:
  - App shall prompt user to reposition ticket.
  - App shall retry capture and OCR automatically.
  - App shall avoid speaking uncertain outputs.

## 6. Non-Functional Requirements
### NFR-1 Performance
- In ideal conditions, from stable ticket placement to spoken output shall be < 1 second (p95).
- OCR and post-processing pipeline shall be optimized for low latency over perfect robustness in MVP.

### NFR-2 Accuracy
- Under good lighting and focus with known template, name + seat extraction success rate shall be > 95%.

### NFR-3 Platform
- MVP browser support: Google Chrome (desktop).

### NFR-4 Availability/Security/Privacy
- No explicit non-functional targets defined for MVP.

## 7. Data and Storage
### 7.1 Persistent Data
- No database required for MVP.

### 7.2 Runtime Data
- Temporary in-memory OCR results and confidence scores.
- Mapping of pre-recorded audio file names:
  - Name audio file should map to holder name key.
  - Seat audio file should map to seat key.

### 7.3 Logging
- Minimal local diagnostic logs (debug mode only), no mandatory persistence.

## 8. High-Level Architecture
Two acceptable implementation modes:

### Option A: Fully Local
- Browser camera capture.
- In-browser template alignment + OCR.
- In-browser validation + audio selection + playback.

### Option B: Hybrid (Self-Hosted)
- Browser camera capture.
- Frame/ROI sent to self-hosted OCR backend.
- Backend returns parsed name, seat, confidence.
- Browser handles validation, UI, and audio output.

Constraint:
- No external OCR SaaS/API provider.

## 9. Processing Pipeline (Normative)
1. Start scan and open webcam stream.
2. Detect ticket template region.
3. Correct orientation to canonical view.
4. Extract ROI for name and seat fields.
5. Run OCR for multilingual name and alphanumeric seat.
6. Validate seat using regex `^[0-9]{2}[A-Z]{2}[0-9]{2}$`.
7. Score confidence per field and combined result.
8. If confidence pass:
   - Render text.
   - Resolve audio files.
   - Play pre-recorded clips or TTS fallback.
9. If confidence fail:
   - Show reposition prompt.
   - Retry automatically.

## 10. UX Requirements
- Clear camera preview with framing guidance.
- Simple states:
  - Ready
  - Scanning
  - Recognized
  - Retry needed
- Display recognized text before/while speaking.
- Retry prompt shall be actionable and concise.

## 11. Configuration Parameters
- `confidence_threshold_name` (default TBD during implementation)
- `confidence_threshold_seat` (default TBD during implementation)
- `scan_timeout_ms` (default TBD)
- `retry_interval_ms` (default TBD)
- `audio_playback_rate` (default 1.0)
- `seat_regex` fixed to `^[0-9]{2}[A-Z]{2}[0-9]{2}$` for MVP

## 12. Acceptance Criteria (MVP)
### AC-1 Core Recognition
- Given a valid ticket in good lighting and focus,
- When user places it under webcam at arbitrary rotation,
- Then app extracts full name and seat number correctly.

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
- Given ideal environment and known template,
- Then p95 end-to-end latency is < 1 second.

### AC-6 Browser Target
- MVP behavior is validated and supported on desktop Chrome.

## 13. Test Plan Summary
### 13.1 Functional Tests
- Correct extraction on canonical orientation.
- Correct extraction at multiple rotations.
- Mixed language names (Chinese and English).
- Seat validation positive and negative cases.
- Audio playback path for:
  - pre-recorded exists
  - pre-recorded missing -> TTS fallback
- Low-confidence prompt and retry behavior.

### 13.2 Performance Tests
- Measure p50/p95 latency from stable frame to first audio output.
- Run on HD webcam in good lighting; minimum sample size defined during implementation planning.

### 13.3 Accuracy Tests
- Evaluate recognition success over representative ticket set using single known template.
- Pass criterion: >95% name+seat correctness in ideal conditions.

## 14. Risks and Mitigations
- OCR errors for similar characters (e.g., `O/0`, `I/1`)
  - Mitigation: strict seat format validation and confidence gating.
- Latency risk on low-end hardware
  - Mitigation: limit processing resolution and optimize inference path.
- Chinese name pronunciation quality in TTS fallback
  - Mitigation: prefer curated pre-recorded names when available.

## 15. Open Implementation Decisions
- Choose final OCR runtime path: local-only vs hybrid self-hosted.
- Set final confidence thresholds based on calibration.
- Define final list and naming convention for pre-recorded audio assets.
- Finalize measurement method for "ticket placement" start event in latency KPI.

## 16. Definition of Done (MVP)
- All acceptance criteria in Section 12 pass on Chrome desktop.
- Accuracy and latency targets are met in the defined ideal test environment.
- User can complete full flow: place ticket -> see result -> hear result.
