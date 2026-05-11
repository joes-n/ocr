from __future__ import annotations

import re
from typing import Any


SEAT_REGEX = re.compile(r"([0-9]{2}[A-Z]{2}[0-9]{2})")
LABEL_WORD_REGEX = re.compile(r"(seat|座位|姓名|name)", re.IGNORECASE)
NAME_LIKE_REGEX = re.compile(r"[A-Za-z\u4e00-\u9fff]")
EXCLUDED_NAME_WORDS = {"sample", "graduate"}


def sanitize_seat_text(text: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", text.upper())


def normalize_name_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def normalize_expected_name(text: str | None) -> str:
    return normalize_name_text(text or "").casefold()


def _candidate(text: str, confidence: float, index: int, raw_text: str) -> dict[str, Any]:
    return {
        "text": text,
        "confidence": float(confidence),
        "index": int(index),
        "raw_text": raw_text,
    }


def _item_text(item: Any) -> str:
    if isinstance(item, dict):
        return str(item.get("text", "")).strip()
    return str(getattr(item, "text", "")).strip()


def _item_confidence(item: Any) -> float:
    try:
        if isinstance(item, dict):
            return float(item.get("confidence", 0.0))
        return float(getattr(item, "confidence", 0.0))
    except (TypeError, ValueError):
        return 0.0


def _looks_like_name(text: str) -> bool:
    trimmed = normalize_name_text(text)
    if len(trimmed) < 2:
        return False
    if not NAME_LIKE_REGEX.search(trimmed):
        return False
    if LABEL_WORD_REGEX.search(trimmed):
        return False
    return trimmed.casefold() not in EXCLUDED_NAME_WORDS


def score_ocr_items(items: list[dict[str, Any]]) -> dict[str, Any]:
    seat_candidates: list[dict[str, Any]] = []
    name_candidates: list[dict[str, Any]] = []

    for index, item in enumerate(items):
        raw_text = _item_text(item)
        if not raw_text:
            continue

        confidence = _item_confidence(item)
        seat_match = SEAT_REGEX.search(sanitize_seat_text(raw_text))
        if seat_match:
            seat_candidates.append(_candidate(seat_match.group(1), confidence, index, raw_text))

        if _looks_like_name(raw_text):
            name_candidates.append(_candidate(normalize_name_text(raw_text), confidence, index, raw_text))

    seat_candidates.sort(key=lambda candidate: candidate["confidence"], reverse=True)
    name_candidates.sort(key=lambda candidate: candidate["confidence"], reverse=True)

    selected_seat = seat_candidates[0] if seat_candidates else None
    selected_name = None
    filtered_name_candidates = name_candidates
    if selected_seat is not None:
        filtered_name_candidates = [
            candidate for candidate in name_candidates if candidate["index"] != selected_seat["index"]
        ]
        selected_name = filtered_name_candidates[0] if filtered_name_candidates else None
    elif name_candidates:
        selected_name = name_candidates[0]

    has_seat = selected_seat is not None
    has_separate_name = selected_name is not None and (
        selected_seat is None or selected_name["index"] != selected_seat["index"]
    )
    is_complete = has_seat and has_separate_name

    if not items:
        failure_reason = "no_ocr_items"
    elif not has_seat:
        failure_reason = "no_seat_candidate"
    elif not has_separate_name:
        failure_reason = "name_candidates_only_on_seat_line" if name_candidates else "no_name_candidate"
    else:
        failure_reason = None

    seat_confidence = float(selected_seat["confidence"]) if selected_seat is not None else 0.0
    name_confidence = float(selected_name["confidence"]) if selected_name is not None else 0.0
    combined_confidence = min(seat_confidence, name_confidence) if is_complete else max(seat_confidence, name_confidence)

    # Large fixed weights make parse validity dominate confidence. Confidence
    # only breaks ties after a pass has the required fields.
    score = (200.0 if has_seat else 0.0) + (100.0 if has_separate_name else 0.0) + combined_confidence

    return {
        "is_complete": is_complete,
        "failure_reason": failure_reason,
        "score": score,
        "seat_candidates": seat_candidates,
        "name_candidates": name_candidates,
        "selected_seat": selected_seat,
        "selected_name": selected_name,
        "confidence": {
            "seat": seat_confidence,
            "name": name_confidence,
            "combined": combined_confidence,
        },
    }


def compare_expected(scored: dict[str, Any], expected_name: str | None, expected_seat: str | None) -> dict[str, Any]:
    selected_name = scored.get("selected_name")
    selected_seat = scored.get("selected_seat")
    actual_name = selected_name.get("text") if isinstance(selected_name, dict) else None
    actual_seat = selected_seat.get("text") if isinstance(selected_seat, dict) else None

    expected_name_normalized = normalize_expected_name(expected_name)
    actual_name_normalized = normalize_expected_name(actual_name)
    expected_seat_normalized = sanitize_seat_text(expected_seat or "")
    actual_seat_normalized = sanitize_seat_text(actual_seat or "")

    name_match = bool(expected_name_normalized) and actual_name_normalized == expected_name_normalized
    seat_match = bool(expected_seat_normalized) and actual_seat_normalized == expected_seat_normalized

    return {
        "actual_name": actual_name,
        "actual_seat": actual_seat,
        "expected_name": expected_name,
        "expected_seat": expected_seat,
        "name_match": name_match,
        "seat_match": seat_match,
        "passed": name_match and seat_match,
    }
