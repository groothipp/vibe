# Vibe install script for Windows
# Usage: irm https://raw.githubusercontent.com/groothipp/vibe/main/scripts/install.ps1 | iex

$ErrorActionPreference = "Stop"
$Repo = "groothipp/vibe"
$ApiUrl = "https://api.github.com/repos/$Repo/releases/latest"

Write-Host "Installing Vibe..." -ForegroundColor Cyan

# Get latest release
$Release = Invoke-RestMethod -Uri $ApiUrl
$Tag = $Release.tag_name

if (-not $Tag) {
    Write-Host "Error: could not find latest release" -ForegroundColor Red
    exit 1
}

Write-Host "  Version: $Tag"

# Find .msi asset
$MsiAsset = $Release.assets | Where-Object { $_.name -like "*.msi" } | Select-Object -First 1

if (-not $MsiAsset) {
    Write-Host "Error: could not find .msi download" -ForegroundColor Red
    exit 1
}

# Download
$TmpDir = Join-Path $env:TEMP "vibe-install"
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
$MsiPath = Join-Path $TmpDir $MsiAsset.name

Write-Host "  Downloading..."
Invoke-WebRequest -Uri $MsiAsset.browser_download_url -OutFile $MsiPath

# Install
Write-Host "  Installing..."
Start-Process msiexec.exe -ArgumentList "/i", "`"$MsiPath`"", "/passive" -Wait

# Clean up download
Remove-Item -Recurse -Force $TmpDir

# Find installed app binary
$AppBin = $null
$SearchPaths = @(
    "${env:ProgramFiles}\Vibe Editor\Vibe Editor.exe",
    "${env:LOCALAPPDATA}\Vibe Editor\Vibe Editor.exe"
)
foreach ($p in $SearchPaths) {
    if (Test-Path $p) { $AppBin = $p; break }
}

if (-not $AppBin) {
    Write-Host ""
    Write-Host "Vibe installed. Could not locate binary to set up CLI." -ForegroundColor Yellow
    Write-Host "You can run it from the Start Menu."
    exit 0
}

# Install CLI (vibe.cmd next to the app, add to PATH)
$AppDir = Split-Path $AppBin
$CmdPath = Join-Path $AppDir "vibe.cmd"

$CmdContent = @"
@echo off
rem vibe-cli-wrapper
if "%~1"=="" (set "TARGET=.") else (set "TARGET=%~1")
if not exist "%TARGET%\" (echo vibe: '%TARGET%' is not a directory >&2 & exit /b 1)
pushd "%TARGET%"
start "" "$AppBin"
popd
"@

Set-Content -Path $CmdPath -Value $CmdContent -Encoding ASCII

# Add to PATH if not already there
$MachinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
if ($MachinePath -notlike "*$AppDir*") {
    Write-Host "  Adding to PATH..."
    [Environment]::SetEnvironmentVariable("Path", "$MachinePath;$AppDir", "Machine")
}

Write-Host ""
Write-Host "Vibe installed successfully." -ForegroundColor Green
Write-Host "  App: $AppBin"
Write-Host "  CLI: $CmdPath"
Write-Host ""
Write-Host "Restart your terminal, then run 'vibe' from any directory."
