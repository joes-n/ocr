## Goals

* Extract **label crop** reliably even when:

  * ticket is partially occluded by hand,
  * ticket boundary is incomplete,
  * ticket is wrinkled (not planar),
  * lighting varies.

* Only use full ticket homography when it’s available and stable; otherwise, localize the label directly.

---

# Pipeline

## Stage 0 — Frame management

1. **Downscale** to a working size (e.g. longest side 640–960) for detection.
2. Keep the original resolution frame for final ROI crop/OCR (or at least a higher-res crop).

**Output:** `frameSmall`, `frameFull`.

---

## Stage 1 — Fast candidate region proposal (blue ticket + hand suppression)

Wrinkles and hands destroy edge-based ticket detection. Use color + soft geometry first.

### 1.1 Blue mask (ticket-ish)

Compute a **blue likelihood mask** (HSV or Lab-based). This doesn’t have to be perfect; it just narrows search.

* HSV blue-ish: `H ∈ [170°, 220°]`, `S ≥ 0.10`, `V ≥ 0.10` (tune)
* Optionally combine with Lab: blue tends to push `b` negative-ish (implementation dependent).

### 1.2 Skin/hand suppression (optional but helps a lot)

If a hand blocks the ticket, you want to avoid selecting the hand as part of the “ticket blob”.

* Quick skin mask (HSV/YCrCb heuristic). Keep it simple: it’s a suppressor, not a detector.
* Subtract/penalize skin-like pixels from the blue mask.

### 1.3 Connected components / blobs

Find components on the blue mask:

* keep top 1–3 components by area
* score by:

  * area ratio (not too tiny),
  * “blue purity” (fraction of blue mask in bbox),
  * temporal overlap with previous frame.

**Output:** `ticketRegionCandidates[]` (rects, not quads).

> Key difference: at this stage, you’re not trying to get 4 corners. You’re just finding “likely ticket region” even if partially occluded.

---

## Stage 2 — Label detection (primary path)

**This becomes your main solver**, because it still works when the ticket edges/corners are missing.

### 2.1 Where to search for label

Search label in:

1. the best `ticketRegionCandidate` crop (preferred)
2. fallback: whole frame (if ticket region is unreliable)

### 2.2 Label segmentation (lighting-robust)

Avoid fixed HSV thresholds for white; use **relative** brightness + **neutrality**.

Recommended mask rule (no Lab needed):

* Bright: `min(R,G,B) >= brightMin` (start 110)
* Neutral: `max(R,G,B) - min(R,G,B) <= neutralSpread` (start 14–18)
* Optional: low saturation: `S <= 0.12` (start 0.12)

Use adaptive brightness if lighting swings:

* set `brightMin = max(90, percentile(minRGB, 70))` inside the search crop

Clean up:

* morphological close → open (small kernels)

### 2.3 Candidate rectangles

Find connected components / contours on the white mask.
For each component:

* fit rotated rect (`minAreaRect` if available; otherwise axis-aligned bbox)
* score by:

  * **rectangularity**: `area(component)/area(rect)` high
  * **aspect**: label aspect in a range (wide rectangle)
  * **area**: within [min,max] relative to search crop
  * **edge density inside**: label has text edges
  * **blue ring context**: pixels just outside rect should be “blue-ish”
  * **NOT blue inside**: penalize if blueInsideRatio high (this kills “washed blue” false positives)
  * **border-touch penalty**: reject if rect touches crop edges too much (likely clipped/false)

Keep top-K candidates and pick best by total score.

**Output:** `labelRect` (prefer rotated rect) + `labelConfidence`.

### 2.4 Rectify label (label homography)

Warp the label rect to a fixed label canvas size, e.g. `800×250`.
This is **much easier than warping the whole ticket** and remains valid even if the ticket is wrinkled (label area is usually locally flatter than the full ticket).

**Output:** `labelCanvasCanonical`.

---

## Stage 3 — Name/seat extraction inside label (stable)

Now you can safely hardcode in the label coordinate system, because you’ve canonicalized the label itself.

Two approaches:

### 3.1 ROI-based inside label (fast)

* name ROI = upper/middle region
* seat ROI = bottom region
  These ROIs won’t drift with ticket rotation anymore.

### 3.2 OCR-all + positional parsing (more robust)

Run OCR on the entire labelCanvasCanonical, then:

* choose the largest text line as name (often Chinese)
* find token matching `Seat` or pattern like `[A-Z0-9]{3,}` etc
  This avoids hardcoding ROI boundaries.

> For your use case, OCR-all + parsing is often easier than tuning ROIs.

---

## Stage 4 — Optional: ticket plane / full homography (best-case enhancement)

Only do this when you have enough visible ticket boundary.

### 4.1 Conditions to attempt full ticket quad

Attempt “document scanner quad” only if:

* blue region component is large and solid,
* boundary is not heavily occluded,
* you can find a stable 4-corner approx (convex quad) with high confidence.

If it fails, skip it; don’t block the pipeline.

### 4.2 Use full ticket warp to improve label search

If you succeed in full ticket homography:

* use normalized ticket canvas as search space for label (reduces false positives further)
  But still keep label-first as the primary outcome.

---

## Stage 5 — Temporal logic (tracking + gating)

This is how you make it stable in realtime without overcomputing.

### 5.1 Track what matters

Track:

* `labelRect` corners (or center/size/angle)
* optionally `ticketRegionCandidate` bbox

Use simple EMA:

* alpha 0.2–0.35

### 5.2 Re-detect policy

* If `labelConfidence >= T_good` (e.g. 0.6): track only, skip full detection for N frames
* If `labelConfidence < T_low` (e.g. 0.45) or border-touch triggered: re-run label detection
* If lost label for M frames: re-run ticket region proposal + full label detect

### 5.3 Output gating

Only emit final name/seat if:

* label rect is stable for N consecutive frames (e.g. 3)
* OCR confidence or parse confidence passes threshold
  Otherwise show “move ticket/label into view”.

---

# Handling hand occlusion explicitly

1. **Don’t rely on ticket corners** for success.
2. Use **skin suppression** so hand doesn’t poison the blue blob / edges.
3. Border-touch rule on label: if label candidate touches crop border, treat as “likely clipped” and:

   * expand search crop (increase padding),
   * or switch to full-frame label search.
4. UI cue: “label partially blocked” is better than wrong ROI.

---

# Handling wrinkles

Wrinkles break “one global plane homography”. So:

* Make full ticket warp optional.
* Prefer **local label warp** (small area) as your canonical coordinate system.
* In scoring, tolerate lower rectangularity and add “text edge density” + “blue ring” constraints (wrinkles distort boundaries but text and context remain).

---

# Implementation notes for your current codebase

* You already have:

  * blue mask logic (`ticket-localizer.ts`)
  * label scoring framework (`ticket-label-localizer.ts`)
  * ROI extractor that supports label-anchor (`ticket-roi.ts`)
* The key changes are:

  1. Treat label detection as the **primary success path**, not an optional anchor.
  2. Improve “white label mask” using **neutrality + adaptive brightness** and add **blue-inside penalty** and **border-touch reject**.
  3. Add search fallback: if label not found in ticket crop → search full frame (or expanded crop).
  4. Warp **label** to canonical before ROIs/OCR.

---

## Recommended thresholds (starting points)

* `T_good = 0.60`, `T_low = 0.45`
* Neutral spread: `<= 14` (loosen to 18 if warm tint)
* Bright minRGB: `>= 110` (adaptive with percentile if needed)
* Blue ring ratio required: `>= 0.25` (tune)
* Blue inside ratio max: `<= 0.12`
* Border margin: `2%` of min dimension

---
