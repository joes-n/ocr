# Plan: Keep PaddleOCR Workflow, Fix Latency With OCR-Guided ROI (No Separate Localizer)

## Summary
The current flow is not logically broken. The issue is performance budget mismatch: OCR often takes longer than the frontend timeout, so the UI reports failure while backend processing continues.
We will keep the same architecture (camera -> PaddleOCR -> parse name/seat), and improve it with:

1. better timeout/backpressure behavior,
2. faster OCR settings,
3. OCR-guided ROI cropping on subsequent frames (without reintroducing brittle fixed localizers).

This preserves Chinese+English support and targets p95 < 3s on current CPU setup.

## Public Interfaces and Config Changes

### Backend API (POST /ocr)

- Keep request contract unchanged (multipart/form-data, file field).
- Extend response shape:
    - results: existing OCR items.
    - meta: { decode_ms, resize_ms, ocr_ms, total_ms, input_w, input_h, resized_w, resized_h }.
    - error: present only on failure.
- Error behavior:
    - Return HTTP 500 for OCR failures (already aligned in code), not HTTP 200 with hidden error.

### Frontend Types

- Extend OCR response type to include optional meta and error.
- Add ROI state type:
    - roi: { x: number, y: number, w: number, h: number } | null in normalized coordinates.
    - roiMissCount: number.
    - frameCounter: number.

### Runtime Config Defaults

- scan_timeout_ms: raise default to 12000.
- Keep env override via VITE_SCAN_TIMEOUT_MS.
- Add optional frontend env:
    - VITE_FULL_FRAME_MAX_SIDE=1280
    - VITE_ROI_MAX_SIDE=960
    - VITE_ROI_REFRESH_EVERY=10
    - VITE_ROI_MISS_RESET=3
- Add backend env:
    - OCR_MAX_IMAGE_SIDE=1280 (default)
    - OCR_USE_TEXTLINE_ORIENTATION=0 (default off for speed)
    - OCR_LANG=ch (keeps Chinese+English coverage)
    - OCR_ENABLE_MKLDNN=1 (default on)

## Implementation Plan

## 1. Frontend Request/Loop Reliability

1. Replace fixed setInterval sampling with single-flight async loop (await each OCR cycle, then schedule next iteration).
2. Keep one in-flight request max.
3. Handle timeout explicitly:
    - AbortError -> user message: timeout with configured ms.
4. Respect backend error payloads:
    - If error exists in JSON, treat as failure state.
5. Surface backend timing (meta.total_ms) in status text for live diagnostics.

## 2. OCR-Guided ROI (No Separate Detector)

1. First pass (or refresh frame): use full-frame capture.
2. Derive ROI from OCR boxes of strongest candidate lines:
    - Include matched seat line and top name candidate.
    - Build union bbox, expand by 35%, clamp to frame bounds.
    - Convert/store as normalized ROI.
3. Next frames:
    - Capture only ROI crop and send to backend.
4. ROI fallback rules:
    - Every N=10 frames, force full-frame pass (drift recovery).
    - If no valid parse for 3 consecutive frames, clear ROI and return to full frame.
5. Keep parser logic intact (seat regex + confidence gating), only change image region fed to OCR.

## 3. Backend Performance Tuning

1. Make MAX_IMAGE_SIDE env-configurable (default 1280).
2. Turn textline orientation off by default (use_textline_orientation=False), overridable by env.
3. Enable MKLDNN by default (enable_mkldnn=True), overridable by env.
4. Add per-request timing instrumentation and include meta in response.
5. Keep CORS and endpoint path unchanged.

## 4. Measurement and Acceptance

1. Add a small benchmark script (or extend existing backend/test_script.py) to run repeated OCR calls and print p50/p95 for:
    - full-frame mode,
    - ROI-guided mode.
2. Frontend logs:
    - capture-to-response ms,
    - parse success/failure,
    - ROI active/full-frame marker.

## Test Cases and Scenarios

## Functional

1. Valid ticket (Chinese name + valid seat) returns parsed values and moves to recognized state.
2. Invalid seat format is rejected and retries continue.
3. Backend exception returns HTTP 500; frontend displays actionable failure reason.
4. ROI recovery:
    - drift/misalignment triggers periodic full-frame refresh and recovers.

## Performance

1. Cold start: first request latency recorded separately.
2. Warm run (>=30 samples): verify p50/p95 end-to-end.
3. Pass target: p95 < 3s in ideal conditions on current machine.

## Accuracy

1. Compare baseline full-frame vs ROI-guided on a representative sample set.
2. Ensure no material regression in name/seat extraction (target remains >95% under ideal conditions).

## Assumptions and Defaults

1. CPU-only local deployment (no mandatory GPU path).
2. Chinese+English text support remains required.
3. No separate CV localizer model in this phase.
4. Balanced speed/quality mode is default:
    - moderate downscale,
    - orientation off by default,
    - full-frame fallback safeguards enabled.
