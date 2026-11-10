# Efekta CLI & MCP Server Installer (Windows PowerShell)
# Run in PowerShell: .\install.ps1
$ErrorActionPreference = "Stop"

Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "     Efekta CLI & MCP Server — Windows Installer      " -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan

# 1. Check for Go
$goCmd = Get-Command go -ErrorAction SilentlyContinue
if (-not $goCmd) {
    Write-Host "`nGo compiler was not found on your PC." -ForegroundColor Yellow
    Write-Host "Install Go with winget (recommended):" -ForegroundColor White
    Write-Host "  winget install GoLang.Go" -ForegroundColor Green
    Write-Host "Or download the installer from: https://go.dev/dl/`n" -ForegroundColor Gray
    exit 1
}

$goVer = go version
Write-Host "✓ Found Go: $goVer" -ForegroundColor Green

# 2. Build executable
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }

$binDir = Join-Path $scriptDir "bin"
if (-not (Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
}

$exePath = Join-Path $binDir "efekta.exe"
Write-Host "`nBuilding static Windows binary (efekta.exe)..." -ForegroundColor White

Push-Location $scriptDir
try {
    $env:CGO_ENABLED = "0"
    & go build -trimpath -ldflags="-s -w" -o $exePath ./cmd/efekta
} finally {
    Pop-Location
}

if (-not (Test-Path $exePath)) {
    Write-Host "Failed to build efekta.exe" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Built $exePath" -ForegroundColor Green

# 3. Install to %USERPROFILE%\.local\bin
$targetDir = Join-Path $env:USERPROFILE ".local\bin"
if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}

$installedExe = Join-Path $targetDir "efekta.exe"
Copy-Item -Path $exePath -Destination $installedExe -Force
Write-Host "✓ Installed to $installedExe" -ForegroundColor Green

# 4. Check & Update User PATH
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$targetDir*") {
    Write-Host "`nAdding $targetDir to User PATH environment variable..." -ForegroundColor Yellow
    $newPath = "$userPath;$targetDir"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    $env:Path = "$env:Path;$targetDir"
    Write-Host "✓ PATH updated successfully." -ForegroundColor Green
}

# 5. Success Banner & Instructions
Write-Host "`n======================================================" -ForegroundColor Green
Write-Host "     Installation Complete!                           " -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor Green

Write-Host "`nNext 2 Steps to Start:" -ForegroundColor Cyan
Write-Host "1. Load Extension in Chrome, Brave, or Edge:" -ForegroundColor White
Write-Host "   • Open: chrome://extensions (or edge://extensions)" -ForegroundColor Yellow
Write-Host "   • Toggle 'Developer mode' ON (top-right corner)" -ForegroundColor Yellow
Write-Host "   • Click 'Load unpacked' and select this folder:" -ForegroundColor Yellow
Write-Host "     $scriptDir\extension" -ForegroundColor Green
Write-Host "2. Open https://learn.better.efekta.com and in a new terminal run:" -ForegroundColor White
Write-Host "   efekta status" -ForegroundColor Green
Write-Host "   efekta auto" -ForegroundColor Green
