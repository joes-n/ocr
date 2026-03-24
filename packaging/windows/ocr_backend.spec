from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata


SPEC_ROOT = Path(__file__).resolve().parent
REPO_ROOT = SPEC_ROOT.parents[1]
BACKEND_ENTRY = REPO_ROOT / "backend" / "main.py"
DIST_DIR = REPO_ROOT / "dist"

datas = []
if DIST_DIR.is_dir():
    datas.append((str(DIST_DIR), "dist"))

datas += copy_metadata("fastapi")
datas += copy_metadata("numpy")
datas += copy_metadata("opencv-python-headless")
datas += copy_metadata("paddleocr")
datas += copy_metadata("paddlepaddle")
datas += copy_metadata("python-multipart")
datas += copy_metadata("starlette")
datas += copy_metadata("uvicorn")
datas += collect_data_files("cv2")
datas += collect_data_files("numpy")
datas += collect_data_files("paddle")
datas += collect_data_files("paddleocr")
datas += collect_data_files("paddlex")

hiddenimports = []
hiddenimports += collect_submodules("cv2")
hiddenimports += collect_submodules("fastapi")
hiddenimports += collect_submodules("paddle")
hiddenimports += collect_submodules("paddleocr")
hiddenimports += collect_submodules("paddlex")
hiddenimports += collect_submodules("starlette")
hiddenimports += collect_submodules("uvicorn")


a = Analysis(
    [str(BACKEND_ENTRY)],
    pathex=[str(REPO_ROOT)],
    binaries=[],
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
