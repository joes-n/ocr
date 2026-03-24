from pathlib import Path

from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
    copy_metadata,
)


SPEC_ROOT = Path(SPECPATH)
REPO_ROOT = SPEC_ROOT.parents[1]
BACKEND_ENTRY = REPO_ROOT / "backend" / "main.py"
DIST_DIR = REPO_ROOT / "dist"

datas = []
binaries = []
hiddenimports = []


def add_distribution_metadata(distribution_name):
    try:
        datas.extend(copy_metadata(distribution_name))
    except Exception:
        pass


def add_import_package(package_name):
    try:
        datas.extend(collect_data_files(package_name))
    except Exception:
        pass

    try:
        binaries.extend(collect_dynamic_libs(package_name))
    except Exception:
        pass

    try:
        hiddenimports.extend(collect_submodules(package_name))
    except Exception:
        pass


if DIST_DIR.is_dir():
    datas.append((str(DIST_DIR), "dist"))

# Core app/runtime metadata.
for distribution_name in [
    "fastapi",
    "numpy",
    "opencv-python-headless",
    "opencv-contrib-python",
    "paddleocr",
    "paddlepaddle",
    "paddlex",
    "python-multipart",
    "starlette",
    "uvicorn",
]:
    add_distribution_metadata(distribution_name)

# PaddleX OCR extras are checked via importlib.metadata at runtime, so their
# dist-info metadata must be present in the frozen app even if the build venv
# already has them installed.
for distribution_name in [
    "imagesize",
    "lxml",
    "openpyxl",
    "premailer",
    "pyclipper",
    "pypdfium2",
    "python-bidi",
    "regex",
    "scikit-learn",
    "scipy",
    "sentencepiece",
    "shapely",
    "tiktoken",
    "tokenizers",
]:
    add_distribution_metadata(distribution_name)

# Bundle the importable packages for dependencies PaddleX loads through its OCR
# pipeline and optional runtime checks.
for package_name in [
    "cv2",
    "imagesize",
    "lxml",
    "numpy",
    "openpyxl",
    "paddle",
    "paddleocr",
    "paddlex",
    "premailer",
    "pyclipper",
    "pypdfium2",
    "regex",
    "scipy",
    "sentencepiece",
    "shapely",
    "sklearn",
    "tiktoken",
    "tokenizers",
]:
    add_import_package(package_name)

# python-bidi installs as the `bidi` import package.
add_import_package("bidi")

hiddenimports = sorted(set(hiddenimports))
binaries = list(dict.fromkeys(binaries))
datas = list(dict.fromkeys(datas))


a = Analysis(
    [str(BACKEND_ENTRY)],
    pathex=[str(REPO_ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="ocr-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="ocr-backend",
)
