from __future__ import annotations

import tempfile
from pathlib import Path
import unittest

import cv2

try:
    from backend.qr_ticket import (
        QRTicketError,
        convert_csv_text_to_qr_svgs,
        decode_qr_payloads,
        make_qr_code,
        parse_ticket_payload,
        serialize_ticket_payload,
        validate_ticket_payload,
        write_qr_svg,
    )
except ImportError:
    from qr_ticket import (
        QRTicketError,
        convert_csv_text_to_qr_svgs,
        decode_qr_payloads,
        make_qr_code,
        parse_ticket_payload,
        serialize_ticket_payload,
        validate_ticket_payload,
        write_qr_svg,
    )


class QRTicketTests(unittest.TestCase):
    def test_payload_round_trip_saves_seat_only(self) -> None:
        payload = validate_ticket_payload("10 ac 13", "Jane Chan")

        parsed = parse_ticket_payload(serialize_ticket_payload(payload))

        self.assertEqual(serialize_ticket_payload(payload), "10AC13")
        self.assertIsNone(parsed.name)
        self.assertEqual(parsed.seat, "10AC13")

    def test_legacy_json_payload_still_decodes(self) -> None:
        parsed = parse_ticket_payload('{"v":1,"name":"Jane Chan","seat":"10AC13"}')

        self.assertEqual(parsed.name, "Jane Chan")
        self.assertEqual(parsed.seat, "10AC13")

    def test_rejects_invalid_seat(self) -> None:
        with self.assertRaises(QRTicketError):
            validate_ticket_payload("A")

    def test_accepts_real_csv_seat_formats(self) -> None:
        self.assertEqual(validate_ticket_payload("10AC2").seat, "10AC2")
        self.assertEqual(validate_ticket_payload("10AD10").seat, "10AD10")
        self.assertEqual(validate_ticket_payload("6G59").seat, "6G59")

    def test_recovers_excel_scientific_notation_seat(self) -> None:
        self.assertEqual(validate_ticket_payload("6.00E+60").seat, "6E60")

    def test_generated_code_is_micro_qr_by_default(self) -> None:
        qr_code = make_qr_code(validate_ticket_payload("10AC13"))

        self.assertTrue(qr_code.is_micro)

    def test_micro_qr_decodes_with_zxingcpp(self) -> None:
        expected = validate_ticket_payload("10AC13")
        qr_code = make_qr_code(expected)
        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "10AC13.png"
            qr_code.save(output_path, scale=12, border=4)
            image = cv2.imread(str(output_path), cv2.IMREAD_COLOR)

        decoded = decode_qr_payloads(image)

        self.assertEqual(len(decoded), 1)
        self.assertEqual(decoded[0]["payload"].seat, expected.seat)
        self.assertEqual(decoded[0]["format"], "Micro QR Code")

    def test_written_svg_has_svg_extension_and_content(self) -> None:
        expected = validate_ticket_payload("10AC13")
        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "10AC13.svg"
            written_path = write_qr_svg(output_path, expected)
            content = written_path.read_text(encoding="utf-8")

        self.assertEqual(written_path.suffix, ".svg")
        self.assertIn("<svg", content)

    def test_csv_conversion_creates_output_folder_and_svg_files(self) -> None:
        csv_text = "Seat No,Name\n10AC2,Jane Chan\n6.00E+60,John Lee\n"
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir) / "qr-codes"
            generated = convert_csv_text_to_qr_svgs(csv_text, output_dir)

            self.assertTrue(output_dir.is_dir())
            self.assertEqual([item["filename"] for item in generated], ["10AC2.svg", "6E60.svg"])
            self.assertTrue((output_dir / "10AC2.svg").is_file())
            self.assertTrue((output_dir / "6E60.svg").is_file())

    def test_csv_conversion_overwrites_existing_same_seat_svg(self) -> None:
        csv_text = "Seat No,Name\n10AC13,Jane Chan\n"
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir) / "qr-codes"
            output_dir.mkdir()
            target = output_dir / "10AC13.svg"
            target.write_text("old content", encoding="utf-8")

            generated = convert_csv_text_to_qr_svgs(csv_text, output_dir)

            self.assertEqual(generated[0]["path"], str(target))
            self.assertIn("<svg", target.read_text(encoding="utf-8"))
            self.assertNotIn("old content", target.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
