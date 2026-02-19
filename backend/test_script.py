import requests
import json
import os

url = 'http://127.0.0.1:8000/ocr'
file_path = 'ticket_example.jpg' # Use relative to where we run it from

with open(file_path, 'rb') as f:
    files = {'file': f}
    response = requests.post(url, files=files)
    print(json.dumps(response.json(), indent=2, ensure_ascii=False))
