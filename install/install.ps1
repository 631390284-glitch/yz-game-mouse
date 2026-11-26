#Requires -Version 5.1
<#
    Tracky Mouse 3.1.0 - configurable clutch key patch installer
    ("clutch": cursor movement gated on a mouse button / keyboard key /
     gamepad button, with hold or toggle modes)

    Copies the patched files into an existing Tracky Mouse installation,
    backing up the originals first so that uninstall.ps1 can restore them.
    Also upgrades cleanly from the old "hold left mouse button" patch (v1).

    Usage:
        powershell -ExecutionPolicy Bypass -File install.ps1
        powershell -ExecutionPolicy Bypass -File install.ps1 -ForceStop
        powershell -ExecutionPolicy Bypass -File install.ps1 -AppDir "C:\...\app-3.1.0"
#>
param(
    [string]$AppDir = "",
    [switch]$ForceStop,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$patchRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'patch'
if (-not (Test-Path -LiteralPath $patchRoot)) {
    throw "Patch folder not found: $patchRoot"
}

if (-not $AppDir) {
    $base = Join-Path $env:LOCALAPPDATA 'tracky-mouse'
    if (-not (Test-Path -LiteralPath $base)) {
        throw "Tracky Mouse does not seem to be installed (no '$base'). Install it first, or pass -AppDir."
    }
    $candidates = @(Get-ChildItem -LiteralPath $base -Directory -Filter 'app-*' |
        Sort-Object -Property { [version]($_.Name -replace '^app-', '') } -Descending)
    if ($candidates.Count -eq 0) {
        throw "No 'app-*' folder found under '$base'."
    }
    $AppDir = $candidates[0].FullName
}

$AppDir = (Resolve-Path -LiteralPath $AppDir).Path
$mainJs = Join-Path $AppDir 'resources\app\src\electron-main\electron-main.js'
if (-not (Test-Path -LiteralPath $mainJs)) {
    throw "This does not look like a Tracky Mouse app folder (missing resources\app\src\electron-main\electron-main.js):`n$AppDir"
}

$pkgPath = Join-Path $AppDir 'resources\app\package.json'
if (Test-Path -LiteralPath $pkgPath) {
    $pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
    Write-Host "Found Tracky Mouse $($pkg.version) at:`n  $AppDir`n"
    if ($pkg.version -ne '3.1.0' -and -not $Force) {
        throw "This patch was built and tested against version 3.1.0, but this installation is $($pkg.version). Pass -Force to install anyway (files may not match)."
    }
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

# Install every file that ships under patch\resources, instead of a hand-written
# list. A hand-written list silently goes stale the moment the patch adds a file,
# and a missing module file is not a cosmetic problem: tracky-mouse.js is an ES
# module, so one failed import takes down the whole renderer and the window opens
# blank. (That is exactly what happened when touch-zones.js was added but not
# listed here.) Enumerating the folder makes that class of bug impossible.
$patchResources = Join-Path $patchRoot 'resources'
if (-not (Test-Path -LiteralPath $patchResources)) {
    throw "Patch resources folder not found: $patchResources"
}
$files = @(
    Get-ChildItem -LiteralPath $patchResources -Recurse -File |
        Where-Object { $_.Name -notin @('.DS_Store', 'Thumbs.db', 'desktop.ini') } |
        ForEach-Object {
            $relPath = $_.FullName.Substring($patchResources.Length)
            if ($relPath.StartsWith([string][System.IO.Path]::DirectorySeparatorChar)) {
                $relPath = $relPath.Substring(1)
            }
            'resources\' + $relPath
        } |
        Sort-Object
)
if ($files.Count -eq 0) {
    throw "No patch files found under $patchResources"
}
Write-Host "Patch contains $($files.Count) file(s)."

$backupDir = Join-Path $AppDir 'resources\.lmb-clutch-backup'
$oldManifestPath = Join-Path $backupDir 'manifest.json'

# If a previous version of this patch is installed, first restore its backup,
# so we patch from pristine original files (and don't lose the true originals).
if (Test-Path -LiteralPath $oldManifestPath) {
    Write-Host "Found a previous clutch patch backup; restoring originals first..."
    $oldManifest = Get-Content -LiteralPath $oldManifestPath -Raw | ConvertFrom-Json
    foreach ($entry in $oldManifest) {
        $rel = $entry.path
        $dst = Join-Path $AppDir $rel
        if ($entry.existed) {
            $bak = Join-Path $backupDir $rel
            if (Test-Path -LiteralPath $bak) {
                Copy-Item -LiteralPath $bak -Destination $dst -Force
                Write-Host "  restored $rel"
            }
        } else {
            if (Test-Path -LiteralPath $dst) {
                Remove-Item -LiteralPath $dst -Force
                Write-Host "  removed $rel (it was added by the previous patch)"
            }
        }
    }
}

# Remove files that were part of the old (v1) "left mouse button" patch
# but are no longer part of this patch.
$legacyFiles = @(
    'resources\app\src\electron-main\lmb-watcher.js',
    'resources\bin\tracky-lmb-watch.exe',
    # v19/v20 shipped an extra touch-zones.js module; it is inlined into
    # tracky-mouse.js now, so remove any leftover copy.
    'resources\app\node_modules\tracky-mouse\src\touch-zones.js'
)
foreach ($rel in $legacyFiles) {
    $p = Join-Path $AppDir $rel
    if (Test-Path -LiteralPath $p) {
        Remove-Item -LiteralPath $p -Force
        Write-Host "  removed legacy $rel"
    }
}

if (Test-Path -LiteralPath $backupDir) {
    Write-Host "Removing a leftover backup from a previous run..."
    Remove-Item -LiteralPath $backupDir -Recurse -Force
}
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

$manifest = @()
foreach ($rel in $files) {
    $src = Join-Path $patchRoot $rel
    $dst = Join-Path $AppDir $rel
    if (-not (Test-Path -LiteralPath $src)) {
        throw "Patch file missing: $src"
    }
    $existed = Test-Path -LiteralPath $dst
    if ($existed) {
        $bak = Join-Path $backupDir $rel
        New-Item -ItemType Directory -Path (Split-Path -Parent $bak) -Force | Out-Null
        Copy-Item -LiteralPath $dst -Destination $bak -Force
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Force
    $manifest += [pscustomobject]@{ path = $rel; existed = $existed }
    Write-Host "  patched $rel"
}

$manifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $backupDir 'manifest.json') -Encoding UTF8

# Sanity check: the renderer is a graph of ES modules, so a single missing file
# takes the whole window down (blank window, no error on screen). Verify every
# relative import resolves before declaring success.
$srcDir = Join-Path $AppDir 'resources\app\node_modules\tracky-mouse\src'
if (Test-Path -LiteralPath $srcDir) {
    $missing = @()
    $jsFiles = @(Get-ChildItem -LiteralPath $srcDir -Filter '*.js' -File)
    foreach ($jsFile in $jsFiles) {
        foreach ($line in (Get-Content -LiteralPath $jsFile.FullName)) {
            if ($line -match 'from\s+["''](\.[^"'']+)["'']') {
                $relImport = $matches[1]
                $target = Join-Path $srcDir $relImport
                if (-not (Test-Path -LiteralPath $target)) {
                    $missing += ($jsFile.Name + ' -> ' + $relImport)
                }
            }
        }
    }
    if ($missing.Count -gt 0) {
        $detail = $missing -join [Environment]::NewLine
        throw ("These renderer imports point at files that do not exist:" + [Environment]::NewLine + $detail + [Environment]::NewLine + "The window would come up blank. Aborting.")
    }
    Write-Host ("Renderer imports verified (" + $jsFiles.Count + " modules).")
}

Write-Host ""
Write-Host "Done. Start Tracky Mouse."
Write-Host "In the app: Settings -> Cursor Movement:"
Write-Host "  - 'Gate cursor movement on a key' (the clutch): mode Hold or Toggle,"
Write-Host "    key = click it, then press any mouse/keyboard/gamepad key"
Write-Host "  - 'Cursor position when switched on': screen center / keep it where it is"
Write-Host "Voice control (v34): Settings -> Voice Control -> tick 'Voice control',"
Write-Host "  then say the on/off words (default: 'kaiqi' / 'guanbi'). Recognized"
Write-Host "  locally, offline; the microphone is used only for those two words."
Write-Host "Comfort calibration (v37): the green button next to Start opens it."
Write-Host "  Confirm each of the four corners by OPENING YOUR MOUTH (mouth click is"
Write-Host "  switched on for you during the calibration, then restored). After the"
Write-Host "  four steps, click the big center button within 10 seconds with head"
Write-Host "  control - if you can't, the calibration is discarded and the previous"
Write-Host "  sensitivity comes back automatically."
Write-Host "Max cursor speed (v37): Settings -> Cursor movement -> Point tracking."
Write-Host "  Default 1200 px/s. Calibration raises sensitivity; this cap keeps the"
Write-Host "  reach but stops head jitter from whipping the cursor across the screen."
Write-Host "Auto-return to center (v39): after a few seconds without cursor movement"
Write-Host "  (and without clicks) the cursor glides back to the middle of the screen"
Write-Host "  and the current head pose becomes the new center - this clears the drift"
Write-Host "  that otherwise slowly pushes the cursor to one side."
Write-Host "Calibration (v39): every direction now starts with 'return your head to"
Write-Host "  center' + a mouth confirm, with the cursor placed at the screen center,"
Write-Host "  so each direction is measured from the same baseline. Without this the"
Write-Host "  head stays turned from the previous corner and the result is too weak."
Write-Host "Voice confirmation mark (v39): the one-second yellow '!' next to the cursor"
Write-Host "  now has a size setting (large / medium / small / extra small; default"
Write-Host "  medium = one size smaller than v38)."
Write-Host "Voice-clutch linkage (v38): spoken commands now engage their clutch too -"
Write-Host "  'zhangzui' enables mouth click AND engages the second clutch (no key"
Write-Host "  press needed); 'bizui' disengages it. Touching the physical clutch key"
Write-Host "  afterwards hands control back to the key. Every recognized word also"
Write-Host "  shows a yellow exclamation mark next to the cursor for 1 second, so"
Write-Host "  you can tell it worked even with the app window minimized."
Write-Host "Voice switches (v36): the same panel has three extra switches, all on:"
Write-Host "  'yidong' / 'jingzhi' = cursor movement, 'zhayan' / 'biyan' = blink"
Write-Host "  click, 'zhangzui' / 'bizui' = mouth click. Each can be unticked."
Write-Host "  Memory: enabling voice control adds ~150-190 MB until the app restarts"
Write-Host "  (the section title says so too)."
Write-Host ""
Write-Host "Can't reach the screen corners (v35)? Settings -> Cursor Movement ->"
Write-Host "  'Calibrate comfort range...' - it asks you to turn your head towards"
Write-Host "  each corner once, then scales each direction's sensitivity so that"
Write-Host "  same comfortable motion reaches the corner."
Write-Host ""
Write-Host "For 3D game camera control you also need the ViGEmBus driver:"
Write-Host "  https://github.com/nefarius/ViGEmBus/releases"
Write-Host "(ViGEmClient.dll ships with this patch; only the driver is missing.)"
Write-Host ""
Write-Host "Uncheck the 'Clutch' box to get the stock behaviour back without uninstalling."
Write-Host ""
Write-Host "Note: a Tracky Mouse auto-update will replace these files. Re-run this installer if that happens."
