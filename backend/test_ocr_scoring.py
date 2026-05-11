from __future__ import annotations

import unittest

try:
    from backend.ocr_scoring import compare_expected, score_ocr_items
except ImportError:
    from ocr_scoring import compare_expected, score_ocr_items


class OCRScoringTests(unittest.TestCase):
    def test_valid_name_and_seat_are_complete(self) -> None:
        scored = score_ocr_items(
            [
                {"text": "陳大文", "confidence": 0.91},
                {"text": "10AC13", "confidence": 0.95},
            ]
        )

        self.assertTrue(scored["is_complete"])
        self.assertIsNone(scored["failure_reason"])
        self.assertEqual(scored["selected_name"]["text"], "陳大文")
        self.assertEqual(scored["selected_seat"]["text"], "10AC13")

    def test_seat_only_is_not_complete(self) -> None:
        scored = score_ocr_items([{"text": "10AC13", "confidence": 0.99}])

        self.assertFalse(scored["is_complete"])
        self.assertEqual(scored["selected_seat"]["text"], "10AC13")
        self.assertIn(scored["failure_reason"], {"no_name_candidate", "name_candidates_only_on_seat_line"})

    def test_random_text_without_seat_is_rejected(self) -> None:
        scored = score_ocr_items([{"text": "Welcome", "confidence": 0.99}])

        self.assertFalse(scored["is_complete"])
        self.assertEqual(scored["failure_reason"], "no_seat_candidate")
        self.assertIsNone(scored["selected_seat"])

    def test_confidence_breaks_tie_after_validity(self) -> None:
        low_confidence = score_ocr_items(
            [
                {"text": "陳大文", "confidence": 0.55},
                {"text": "10AC13", "confidence": 0.58},
            ]
        )
        high_confidence = score_ocr_items(
            [
                {"text": "陳大文", "confidence": 0.92},
                {"text": "10AC13", "confidence": 0.95},
            ]
        )

        self.assertTrue(low_confidence["is_complete"])
        self.assertTrue(high_confidence["is_complete"])
        self.assertGreater(high_confidence["score"], low_confidence["score"])

    def test_valid_seat_outranks_name_only_text(self) -> None:
        name_only = score_ocr_items([{"text": "Very Clear Name", "confidence": 0.99}])
        seat_only = score_ocr_items([{"text": "10AC13", "confidence": 0.1}])

        self.assertGreater(seat_only["score"], name_only["score"])

    def test_expected_comparison_normalizes_name_and_seat(self) -> None:
        scored = score_ocr_items(
            [
                {"text": "Jane   Chan", "confidence": 0.91},
                {"text": "Seat: 10 ac 13", "confidence": 0.95},
            ]
        )

        comparison = compare_expected(scored, "jane chan", "10AC13")
        self.assertTrue(comparison["passed"])


if __name__ == "__main__":
    unittest.main()
