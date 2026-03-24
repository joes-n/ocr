param(
    [string]$PythonExe = "",
    [string]$InnoSetupCompiler = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$SpecRoot = Join-Path $RepoRoot "packaging\windows"
$ReleaseRoot = Join-Path $RepoRoot "release\windows"
$PyInstallerDist = Join-Path $ReleaseRoot "pyinstaller"
$PyInstallerWork = Join-Path $ReleaseRoot "pyinstaller-work"
$BundleRoot = Join-Path $ReleaseRoot "bundle"
$InstallerRoot = Join-Path $ReleaseRoot "installer"

if ([string]::IsNullOrWhiteSpace($PythonExe)) {
    $DefaultPython = Join-Path $RepoRoot "backend\.venv\Scripts\python.exe"
    if (Test-Path $DefaultPython) {
        $PythonExe = $DefaultPython
    } else {
        $PythonExe = "py"
    }
}

if ([string]::IsNullOrWhiteSpace($InnoSetupCompiler)) {
    $DefaultIscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
    if (Test-Path $DefaultIscc) {
        $InnoSetupCompiler = $DefaultIscc
    }
}

Write-Host "Repo root: $RepoRoot"
Write-Host "Python executable: $PythonExe"

Push-Location $RepoRoot
try {
    npm run build

    Remove-Item $PyInstallerDist -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $PyInstallerWork -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $BundleRoot -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $PyInstallerDist | Out-Null
    New-Item -ItemType Directory -Path $PyInstallerWork | Out-Null
    New-Item -ItemType Directory -Path $BundleRoot | Out-Null
    New-Item -ItemType Directory -Path $InstallerRoot | Out-Null

    & $PythonExe -m PyInstaller --noconfirm --clean `
        --distpath $PyInstallerDist `
        --workpath $PyInstallerWork `
        $SpecRoot\ocr_backend.spec

    & $PythonExe -m PyInstaller --noconfirm --clean `
        --distpath $PyInstallerDist `
        --workpath $PyInstallerWork `
        $SpecRoot\ocr_launcher.spec

    Copy-Item "$PyInstallerDist\ocr-backend" "$BundleRoot\ocr-backend" -Recurse -Force
    Copy-Item "$PyInstallerDist\ocr-ticket-reader\ocr-ticket-reader.exe" "$BundleRoot\ocr-ticket-reader.exe" -Force

    if (-not [string]::IsNullOrWhiteSpace($InnoSetupCompiler)) {
        & $InnoSetupCompiler `
            "/DSourceBundle=$BundleRoot" `
            "/DReleaseRoot=$ReleaseRoot" `
            "$SpecRoot\OCRTicketReader.iss"
    } else {
        Write-Warning "ISCC.exe not found. PyInstaller bundle created at $BundleRoot but installer was not built."
    }
}
finally {
    Pop-Location
}
