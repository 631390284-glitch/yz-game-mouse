#Requires -Version 5.1
<#
    Tracky Mouse - remove the clutch key patch
    Restores the original files that install.ps1 backed up.

    Usage:
        powershell -ExecutionPolicy Bypass -File uninstall.ps1
        powershell -ExecutionPolicy Bypass -File uninstall.ps1 -ForceStop
        powershell -ExecutionPolicy Bypass -File uninstall.ps1 -AppDir "C:\...\app-3.1.0"
#>
param(
    [string]$AppDir = "",
    [switch]$ForceStop
)

$ErrorActionPreference = 'Stop'

if (-not $AppDir) {
    $base = Join-Path $env:LOCALAPPDATA 'tracky-mouse'
    if (-not (Test-Path -LiteralPath $base)) {
        throw "Tracky Mouse does not seem to be installed (no '$base'). Pass -AppDir if it lives elsewhere."
    }
    $candidates = @(Get-ChildItem -LiteralPath $base -Directory -Filter 'app-*' |
        Sort-Object -Property { [version]($_.Name -replace '^app-', '') } -Descending)
    if ($candidates.Count -eq 0) { throw "No 'app-*' folder found under '$base'." }
    $AppDir = $candidates[0].FullName
}

$AppDir = (Resolve-Path -LiteralPath $AppDir).Path
$backupDir = Join-Path $AppDir 'resources\.lmb-clutch-backup'
$manifestPath = Join-Path $backupDir 'manifest.json'

if (-not (Test-Path -LiteralPath $manifestPath)) {
    Write-Host "No patch backup found at:"
    Write-Host "  $manifestPath"
    Write-Host "Nothing to restore. (The patch may already be removed, or it was installed to a different folder.)"
    exit 0
}

$running = @(Get-Process -Name 'tracky-mouse', 'tracky-mouse_ExecutionStub' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    if ($ForceStop) {
        Write-Host "Stopping Tracky Mouse..."
        $running | Stop-Process -Force
        Start-Sleep -Milliseconds 1000
    } else {
        throw "Tracky Mouse is currently running. Close it and run this again, or add -ForceStop."
    }
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
foreach ($entry in $manifest) {
    $rel = $entry.path
    $dst = Join-Path $AppDir $rel
    if ($entry.existed) {
        $bak = Join-Path $backupDir $rel
        if (-not (Test-Path -LiteralPath $bak)) {
            Write-Warning "Backup missing for $rel; leaving it as is."
            continue
        }
        Copy-Item -LiteralPath $bak -Destination $dst -Force
        Write-Host "  restored $rel"
    } else {
        if (Test-Path -LiteralPath $dst) {
            Remove-Item -LiteralPath $dst -Force
            Write-Host "  removed $rel (it was added by the patch)"
        }
    }
}

Remove-Item -LiteralPath $backupDir -Recurse -Force

# Remove legacy files from older patch versions, if present.
$legacyFiles = @(
    'resources\app\src\electron-main\lmb-watcher.js',
    'resources\bin\tracky-lmb-watch.exe',
    # touch-zones.js is inlined into tracky-mouse.js now.
    'resources\app\node_modules\tracky-mouse\src\touch-zones.js'
)
foreach ($rel in $legacyFiles) {
    $p = Join-Path $AppDir $rel
    if (Test-Path -LiteralPath $p) {
        Remove-Item -LiteralPath $p -Force
        Write-Host "  removed legacy $rel"
    }
}

Write-Host ""
Write-Host "Done. Tracky Mouse is back to the original files."
