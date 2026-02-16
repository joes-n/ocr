# OCR Ticket Reader MVP - Implementation Tasks

Source spec: `SOFTWARE_SPEC.md`

## 0. Project Setup
- [x] `T-001` Initialize web app scaffold (Chrome desktop target only).  
  Trace: Spec §3, §6.3
- [x] `T-002` Add environment/config module for runtime parameters (`confidence_threshold_*`, `scan_timeout_ms`, `retry_interval_ms`, `audio_playback_rate`).  
  Trace: Spec §11
- [x] `T-003` Define shared TypeScript interfaces for OCR result, confidence, app states, and audio resolution output.  
  Trace: Spec §5, §10, §11

## 1. Camera and Scanning Flow
- [x] `T-010` Implement webcam permission request and live preview component.  
  Trace: Spec §5 FR-1
- [x] `T-011` Implement scan controller with states: `Ready`, `Scanning`, `Recognized`, `RetryNeeded`.  
  Trace: Spec §10
- [x] `T-012` Add frame sampling loop with adjustable interval and stop/start lifecycle handling.  
  Trace: Spec §5 FR-1, §11

## 2. Ticket Detection and Orientation
- [x] `T-020` Implement known-template ticket localization in frame.  
  Trace: Spec §5 FR-2
- [x] `T-021` Implement rotation/orientation normalization to canonical ticket view.  
  Trace: Spec §4.1, §5 FR-2, §9
- [x] `T-022` Extract ROIs for name and seat fields from normalized ticket coordinates.  
  Trace: Spec §9

## 3. OCR Integration (No External Provider)
- [ ] `T-030` Select OCR path (`local` or `self-hosted`) and document decision in README note.  
  Trace: Spec §5 FR-4, §8, §15
- [ ] `T-031` Implement OCR adapter interface supporting multilingual name (Chinese/English) and alphanumeric seat recognition.  
  Trace: Spec §5 FR-3, FR-4
- [ ] `T-032` Implement OCR pipeline invocation per captured frame/ROI and return per-field confidence.  
  Trace: Spec §5 FR-5, §9

## 4. Validation and Confidence Gating
- [ ] `T-040` Implement seat format validator with regex `^[0-9]{2}[A-Z]{2}[0-9]{2}$`.  
  Trace: Spec §9, §12 AC-2
- [ ] `T-041` Implement name/seat confidence threshold checks and combined decision logic.  
  Trace: Spec §5 FR-7, §11
- [ ] `T-042` Implement low-confidence behavior: show reposition prompt + automatic retry loop.  
  Trace: Spec §5 FR-7, §12 AC-4

## 5. Result UI and UX
- [ ] `T-050` Build recognition result panel showing name, seat, and confidence indicators.  
  Trace: Spec §5 FR-5, §10
- [ ] `T-051` Add simple camera framing guidance and concise retry messaging.  
  Trace: Spec §10
- [ ] `T-052` Ensure recognized text is rendered before/while audio playback starts.  
  Trace: Spec §10

## 6. Audio Output
- [ ] `T-060` Implement audio asset resolver for name and seat pre-recorded files (exact match lookup).  
  Trace: Spec §5 FR-6, §7.2
- [ ] `T-061` Integrate TTS fallback when pre-recorded asset is unavailable (name and/or seat).  
  Trace: Spec §5 FR-6, §12 AC-3
- [ ] `T-062` Implement output sequence: speak name first, then seat.  
  Trace: Spec §5 FR-6

## 7. End-to-End Orchestration
- [ ] `T-070` Implement full processing pipeline: capture -> localize -> normalize -> OCR -> validate -> confidence gate -> render -> speak.  
  Trace: Spec §9
- [ ] `T-071` Add scan timeout and recovery behavior for no-ticket/no-detection conditions.  
  Trace: Spec §11
- [ ] `T-072` Add duplicate suppression to avoid repeated speaking of same stable result in rapid loop.  
  Trace: Spec §10 (UX clarity), §6.1 (latency/flow stability)

## 8. Performance and Accuracy Validation
- [ ] `T-080` Add instrumentation timestamps for latency measurement from stable ticket detection to first audio output.  
  Trace: Spec §6.1, §13.2
- [ ] `T-081` Create performance test script/protocol and record p50/p95 results in ideal conditions.  
  Trace: Spec §6.1, §12 AC-5, §13.2
- [ ] `T-082` Create accuracy test dataset/protocol for known template and measure name+seat correctness rate.  
  Trace: Spec §6.2, §12 AC-1, §13.3
- [ ] `T-083` Verify target metrics: `>95%` accuracy and `<1s` p95 latency; log pass/fail with evidence.  
  Trace: Spec §6, §12

## 9. Browser and Release Readiness
- [ ] `T-090` Validate full flow on desktop Chrome (supported MVP browser).  
  Trace: Spec §6.3, §12 AC-6
- [ ] `T-091` Add minimal operator documentation: setup, camera conditions, audio asset naming, troubleshooting.  
  Trace: Spec §7.2, §14
- [ ] `T-092` Final MVP checklist sign-off against Definition of Done.  
  Trace: Spec §16

## 10. Acceptance Criteria Verification Checklist
- [ ] `V-AC1` Random rotation ticket recognition succeeds under ideal conditions.
- [ ] `V-AC2` Invalid seat format is rejected and triggers retry prompt.
- [ ] `V-AC3` Pre-recorded audio is preferred; TTS fallback works when file missing.
- [ ] `V-AC4` Low-confidence output is not spoken; auto-retry path works.
- [ ] `V-AC5` p95 end-to-end latency is under 1 second in ideal environment.
- [ ] `V-AC6` Behavior validated on desktop Chrome.

## Execution Order (Recommended)
1. `T-001` -> `T-003`
2. `T-010` -> `T-022`
3. `T-030` -> `T-032`
4. `T-040` -> `T-042`
5. `T-050` -> `T-052`
6. `T-060` -> `T-062`
7. `T-070` -> `T-072`
8. `T-080` -> `T-083`
9. `T-090` -> `T-092`
10. `V-AC1` -> `V-AC6`
