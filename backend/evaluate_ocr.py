from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
import statistics
import time
from typing import Any
import urllib.error
import urllib.request
import uuid

try:
    from .ocr_scoring import compare_expected, score_ocr_items
except ImportError:
    from ocr_scoring import compare_expected, score_ocr_items


DEFAULT_URL = "http://127.0.0.1:8000/ocr"


def _record_value(record: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = record.get(key)
        if value is not None:
            return str(value)
    return ""


def _load_json_manifest(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as file_handle:
        payload = json.load(file_handle)

    if isinstance(payload, dict):
        cases = payload.get("cases") or payload.get("images") or payload.get("records")
    else:
        cases = payload

    if not isinstance(cases, list):
        raise ValueError("JSON manifest must be a list or an object with a cases/images/records list")

    return [dict(case) for case in cases]


def _load_csv_manifest(path: Path, *, delimiter: str = ",") -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8-sig", newline="") as file_handle:
        reader = csv.DictReader(file_handle, delimiter=delimiter)
        return [dict(row) for row in reader]


def load_manifest(path: Path) -> list[dict[str, Any]]:
    suffix = path.suffix.casefold()
    if suffix == ".json":
        records = _load_json_manifest(path)
    elif suffix in {".csv", ".tsv"}:
        records = _load_csv_manifest(path, delimiter="\t" if suffix == ".tsv" else ",")
    else:
        raise ValueError("Manifest must be .json, .csv, or .tsv")

    cases = []
    for index, record in enumerate(records, start=1):
        image_value = _record_value(record, "image", "image_path", "path", "file")
        expected_name = _record_value(record, "expected_name", "name", "holder_name")
        expected_seat = _record_value(record, "expected_seat", "seat", "seat_number")
        if not image_value:
            raise ValueError(f"Manifest row {index} is missing image/image_path/path")

        image_path = Path(image_value).expanduser()
        if not image_path.is_absolute():
            image_path = path.parent / image_path

        cases.append(
            {
                "image": str(image_path),
                "expected_name": expected_name,
                "expected_seat": expected_seat,
            }
        )

    return cases


def post_image(url: str, image_path: Path, timeout: float) -> tuple[dict[str, Any], float]:
    boundary = f"----ocr-ticket-reader-{uuid.uuid4().hex}"
    file_bytes = image_path.read_bytes()
    body = b"".join(
        [
            f"--{boundary}\r\n".encode("utf-8"),
            f'Content-Disposition: form-data; name="file"; filename="{image_path.name}"\r\n'.encode("utf-8"),
            b"Content-Type: application/octet-stream\r\n\r\n",
            file_bytes,
            b"\r\n",
            f"--{boundary}--\r\n".encode("utf-8"),
        ]
    )
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )

    start = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc

    elapsed_ms = (time.perf_counter() - start) * 1000.0
    return json.loads(payload.decode("utf-8")), elapsed_ms


def evaluate_case(url: str, case: dict[str, Any], timeout: float) -> dict[str, Any]:
    image_path = Path(case["image"])
    if not image_path.is_file():
        return {
            **case,
            "passed": False,
            "error": f"image not found: {image_path}",
        }

    try:
        response, elapsed_ms = post_image(url, image_path, timeout)
        items = response.get("results") if isinstance(response, dict) else []
        if not isinstance(items, list):
            items = []
        scored = score_ocr_items(items)
        comparison = compare_expected(scored, case.get("expected_name"), case.get("expected_seat"))
        profiling = response.get("profiling") if isinstance(response, dict) else {}
        debug = response.get("debug") if isinstance(response, dict) else {}
        label_detection = debug.get("label_detection") if isinstance(debug, dict) else {}

        return {
            **case,
            **comparison,
            "latency_ms": round(elapsed_ms, 2),
            "backend_total_ms": profiling.get("total_ms") if isinstance(profiling, dict) else None,
            "backend_path": profiling.get("path") if isinstance(profiling, dict) else None,
            "selected_pass": label_detection.get("selected_pass") if isinstance(label_detection, dict) else None,
            "parse_reason": scored.get("failure_reason"),
            "score": round(float(scored.get("score") or 0.0), 4),
            "confidence": scored.get("confidence"),
            "ocr_count": len(items),
            "error": None,
        }
    except Exception as exc:
        return {
            **case,
            "passed": False,
            "error": str(exc),
        }


def build_summary(records: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(records)
    passed = sum(1 for record in records if record.get("passed"))
    latencies = [float(record["latency_ms"]) for record in records if record.get("latency_ms") is not None]
    return {
        "total": total,
        "passed": passed,
        "failed": total - passed,
        "success_rate": round(passed / total, 4) if total else 0.0,
        "avg_latency_ms": round(statistics.mean(latencies), 2) if latencies else None,
        "records": records,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate OCR success against an external labeled manifest.")
    parser.add_argument("manifest", type=Path, help="Path to .json/.csv manifest outside or inside the repo.")
    parser.add_argument("--url", default=DEFAULT_URL, help=f"OCR endpoint URL. Default: {DEFAULT_URL}")
    parser.add_argument("--timeout", type=float, default=120.0, help="HTTP timeout per image in seconds.")
    parser.add_argument("--json-output", type=Path, help="Optional path to write the full JSON report.")
    parser.add_argument("--fail-on-miss", action="store_true", help="Exit non-zero if any case fails.")
    args = parser.parse_args()

    cases = load_manifest(args.manifest.expanduser())
    records = [evaluate_case(args.url, case, args.timeout) for case in cases]
    summary = build_summary(records)
    report = json.dumps(summary, indent=2, ensure_ascii=False)
    print(report)

    if args.json_output:
        args.json_output.expanduser().write_text(report + "\n", encoding="utf-8")

    return 1 if args.fail_on_miss and summary["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
