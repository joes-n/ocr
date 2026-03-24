from pathlib import Path


SPEC_ROOT = Path(SPECPATH)
REPO_ROOT = SPEC_ROOT.parents[1]
LAUNCHER_ENTRY = REPO_ROOT / "backend" / "launcher.py"


a = Analysis(
    [str(LAUNCHER_ENTRY)],
    pathex=[str(REPO_ROOT)],
    binaries=[],
    datas=[],
    hiddenimports=[],
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
    a.binaries,
    a.datas,
    [],
    name="ocr-ticket-reader",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
)
