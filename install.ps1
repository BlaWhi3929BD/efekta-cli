# Efekta CLI & MCP Server Installer (Windows PowerShell)
# Run in PowerShell: powershell -ExecutionPolicy Bypass -File .\install.ps1
$ErrorActionPreference = "Stop"

Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "     Efekta CLI & MCP Server — Windows Installer      " -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan

# 1. Check for Go
$goCmd = Get-Command go -ErrorAction SilentlyContinue
if (-not $goCmd) {
    $goRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ }
    foreach ($root in $goRoots) {
        foreach ($sub in @("Go\bin\go.exe", "Programs\Go\bin\go.exe")) {
            $candidate = Join-Path $root $sub
            if (Test-Path $candidate) {
                $goBin = Split-Path -Parent $candidate
                $env:Path = "$goBin;$env:Path"
                $goCmd = Get-Command go -ErrorAction SilentlyContinue
                if ($goCmd) { break }
            }
        }
        if ($goCmd) { break }
    }
}
if (-not $goCmd) {
    Write-Host "`nGo compiler was not found on your PC." -ForegroundColor Yellow
    Write-Host "Install Go with winget (recommended):" -ForegroundColor White
    Write-Host "  winget install GoLang.Go" -ForegroundColor Green
    Write-Host "Then restart PowerShell so the new PATH loads, and re-run this installer." -ForegroundColor White
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

if (Test-Path $exePath) {
    Remove-Item -Path $exePath -Force
}

$buildExit = 1
Push-Location $scriptDir
try {
    $env:CGO_ENABLED = "0"
    & go build -trimpath -ldflags="-s -w" -o $exePath ./cmd/efekta
    $buildExit = $LASTEXITCODE
} finally {
    Pop-Location
}

if (($buildExit -ne 0) -or (-not (Test-Path $exePath))) {
    Write-Host "Failed to build efekta.exe (exit code: $buildExit)" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Built $exePath" -ForegroundColor Green

# 3. Install to %USERPROFILE%\.local\bin
$targetDir = Join-Path $env:USERPROFILE ".local\bin"
if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}

$installedExe = Join-Path $targetDir "efekta.exe"
if (Test-Path $installedExe) {
    Write-Host "Stopping any running efekta daemon before updating..." -ForegroundColor Yellow
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $installedExe daemon stop 2>$null | Out-Null
    } finally {
        $ErrorActionPreference = $prevEAP
    }
    for ($i = 0; $i -lt 10; $i++) {
        $locking = Get-Process -Name "efekta" -ErrorAction SilentlyContinue | Where-Object {
            try { $_.Path -ieq $installedExe } catch { $false }
        }
        if (-not $locking) { break }
        if ($i -eq 4) {
            $locking | Stop-Process -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 150
    }
}
Copy-Item -Path $exePath -Destination $installedExe -Force
Write-Host "✓ Installed to $installedExe" -ForegroundColor Green

# 4. Check & Update User PATH (preserve REG_EXPAND_SZ and avoid leading/double semicolons)
$pathUpdated = $false
$envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
if (-not $envKey) {
    $envKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
}
try {
    $rawUserPath = $envKey.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($null -eq $rawUserPath) { $rawUserPath = "" }
    $segments = @($rawUserPath -split ";" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
    $normalizedTarget = $targetDir.TrimEnd("\")
    $unexpandedTarget = "%USERPROFILE%\.local\bin"
    $alreadyInPath = $false
    foreach ($seg in $segments) {
        $expandedSeg = [Environment]::ExpandEnvironmentVariables($seg).TrimEnd("\")
        if (($expandedSeg -ieq $normalizedTarget) -or ($seg.TrimEnd("\") -ieq $unexpandedTarget)) {
            $alreadyInPath = $true
            break
        }
    }
    if (-not $alreadyInPath) {
        Write-Host "`nAdding $targetDir to User PATH environment variable..." -ForegroundColor Yellow
        $newUserPath = (@($segments + $unexpandedTarget)) -join ";"
        $envKey.SetValue("Path", $newUserPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
        $env:Path = ($env:Path.TrimEnd(";") + ";$targetDir").TrimStart(";")
        $pathUpdated = $true
        Write-Host "✓ PATH updated successfully." -ForegroundColor Green
    }
} finally {
    $envKey.Close()
}
if ($pathUpdated) {
    try {
        if (-not ("Win32.NativeMethods" -as [type])) {
            Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(
    System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
"@
        }
        $result = [System.UIntPtr]::Zero
        [Win32.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "Environment", 2, 1000, [ref]$result) | Out-Null
    } catch {
    }
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
Write-Host "`nNote: Restart already-open IDEs/MCP clients (Claude Desktop, Cursor, Windsurf, Antigravity) so they load the updated PATH, or set command to: $installedExe" -ForegroundColor Gray
