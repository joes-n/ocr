import json
import os
import sys

import requests


DEFAULT_URL = os.environ.get("OCR_BACKEND_URL", "http://127.0.0.1:8000/ocr")


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python test_script.py /absolute/path/to/image.jpg", file=sys.stderr)
        return 1

    file_path = sys.argv[1]
    if not os.path.isfile(file_path):
        print(f"Image not found: {file_path}", file=sys.stderr)
        return 1

    with open(file_path, "rb") as file_handle:
        response = requests.post(DEFAULT_URL, files={"file": file_handle})

    response.raise_for_status()
    print(json.dumps(response.json(), indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
