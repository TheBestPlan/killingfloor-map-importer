# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 TheBestPlan

# Launch a map, drive the game by posting keys to its window (no desktop capture, no focus steal, no real
# mouse), take a burst of engine screenshots while turning the view, and convert them to PNG.
#
# ISOLATED from the user's session, but never hidden:
#   - the game window is parked SMALL in the bottom-right corner, on screen (the user can glance at it),
#     never activated by this script - and the focus the game steals at launch is handed straight back to
#     whatever window the user had in front;
#   - all input goes through PostMessage, which needs no focus - the REAL cursor is never touched
#     (mouse_event is gone; while unfocused the game never captures the mouse either);
#   - the view is driven by KEYS the test SDK's User.ini binds: End = TurnRight, Home = TurnLeft,
#     PageUp / PageDown = LookUp / LookDown. -TurnDx/-PitchDy/-StepDy translate to timed key holds.
#   - the reliable way to LOOK at a feature is not turning at all: build the crop with KF_SPAWN_AT
#     "x,y,z,yaw" facing the target and pass -Cmd @("fov 115") for a wide frame.
param([string]$Map = "KF-CS-Assault", [int]$Wait = 16, [string[]]$Cmd = @(), [string]$Tag = "play", [int]$MaxW = 700, [string]$ReadyCmd = "",
      [int]$Shots = 4, [int]$TurnMs = 700, [int]$Gap = 3, [int]$HoldVk = 0, [int]$HoldMs = 0, [int]$PitchDy = 0, [int]$TurnDx = 0, [int]$StepDy = 0, [switch]$Fast, [int]$WalkVk = 0, [string]$Extra = "")
$sdk = if ($env:KF_SDK_DIR) { $env:KF_SDK_DIR } else { throw "set KF_SDK_DIR to the Killing Floor install (the folder with System\KillingFloor.exe)" }
$outDir = if ($env:KF_SHOTS_DIR) { $env:KF_SHOTS_DIR } else { Join-Path $PSScriptRoot "shots" }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Key {
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@ -ErrorAction SilentlyContinue
$VK_TURNR = 0x23; $VK_TURNL = 0x24; $VK_LOOKUP = 0x21; $VK_LOOKDN = 0x22   # End / Home / PageUp / PageDown

function Send-Key($h, $vk) {
  [Key]::PostMessage($h, 0x0100, [IntPtr]$vk, [IntPtr]1) | Out-Null
  Start-Sleep -Milliseconds 60
  [Key]::PostMessage($h, 0x0101, [IntPtr]$vk, [IntPtr]1) | Out-Null
  Start-Sleep -Milliseconds 60
}
function Hold-Key($h, $vk, $ms) {
  $end = (Get-Date).AddMilliseconds($ms)
  while ((Get-Date) -lt $end) { [Key]::PostMessage($h, 0x0100, [IntPtr]$vk, [IntPtr]1) | Out-Null; Start-Sleep -Milliseconds 40 }
  [Key]::PostMessage($h, 0x0101, [IntPtr]$vk, [IntPtr]1) | Out-Null
}
function Send-Text($h, $s) {
  foreach ($ch in $s.ToCharArray()) { [Key]::PostMessage($h, 0x0102, [IntPtr][int]$ch, [IntPtr]1) | Out-Null; Start-Sleep -Milliseconds 35 }
}

# Wait until the level is actually being played before driving the view.
#
# -Wait is a guess, and a guess that is too short poisons the whole run: the shots come from the
# loading fade or the lobby, every frame reads as "empty", and the artefact being hunted looks
# either always present or absent. Probe instead of guessing - take a frame, measure it, and only
# start once it is a live first-person view.
function Wait-Ready($h, $outDir, $here, $tries) {
  for ($k = 0; $k -lt $tries; $k++) {
    Remove-Item "$sdk\Screenshots\*.bmp" -Force -ErrorAction SilentlyContinue
    Send-Key $h 0x78
    # An unfocused window on a busy disk writes the shot late; 1.2 s missed it and the NEXT loop's
    # Remove-Item threw the late file away - every probe missed forever. Poll up to ~4 s instead.
    $bmp = $null
    for ($w = 0; $w -lt 8 -and -not $bmp; $w++) { Start-Sleep -Milliseconds 500; $bmp = Get-ChildItem "$sdk\Screenshots\*.bmp" -ErrorAction SilentlyContinue | Select-Object -First 1 }
    if ($bmp) {
      $probe = Join-Path $outDir "_ready.png"
      node "$here\bmp2png.js" $bmp.FullName $probe 400 | Out-Null
      $verdict = node "$here\flat.js" $probe
      # A live view has detail; the loading fade and the lobby do not.
      if ($verdict -notmatch 'FLAT') {
        Remove-Item "$sdk\Screenshots\*.bmp", $probe -Force -ErrorAction SilentlyContinue
        # The instant the level is live, stop the pawn falling (a bad floor/spawn otherwise drops it to
        # KillZ, the game ends, and KF travels to another map - so the screenshots would be the WRONG level).
        # ghost = no gravity + noclip; the view stays put so geometry can be inspected.
        if ($ReadyCmd) { Send-Key $h 0xC0; Start-Sleep -Milliseconds 300; Send-Text $h $ReadyCmd; Send-Key $h 0x0D; Start-Sleep -Milliseconds 200; Send-Key $h 0xC0; Start-Sleep -Milliseconds 300 }
        return $true
      }
    }
    Start-Sleep -Seconds 2
  }
  return $false
}

# NEVER touch a client the user is running: only a process this harness started (tracked in kf.pid) may be
# stopped. Any other KillingFloor process means the user is playing - bail out without killing anything.
$pidFile = Join-Path $PSScriptRoot "kf.pid"
$mine = if (Test-Path $pidFile) { Get-Content $pidFile -ErrorAction SilentlyContinue } else { $null }
foreach ($kf in (Get-Process KillingFloor -ErrorAction SilentlyContinue)) {
  if ("$($kf.Id)" -eq "$mine") { $kf | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
  else {
    # A process a previous run just killed can linger for a moment - give it 3 s before deciding it is
    # the user's live client.
    Start-Sleep -Seconds 3
    if (Get-Process -Id $kf.Id -ErrorAction SilentlyContinue) { "client busy: a KillingFloor the harness did not start is running (PID $($kf.Id)) - not touching it, aborting"; exit 3 }
  }
}
Remove-Item "$sdk\System\KillingFloor.log", "$sdk\Screenshots\*.bmp" -Force -ErrorAction SilentlyContinue
$userWin = [Key]::GetForegroundWindow()    # whatever the user is working in - given back the moment the game steals focus
Push-Location "$sdk\System"
$proc = Start-Process -FilePath ".\KillingFloor.exe" -ArgumentList "$Map.rom?Game=KFmod.KFGameType?QuickStart=1$Extra -windowed -nosound" -PassThru
Pop-Location
Set-Content $pidFile $proc.Id
# Unfocused, the engine throttles itself and a 50 MB city tile takes minutes to load instead of seconds.
# High priority claws most of that back while keeping the window in the background.
try { $proc.PriorityClass = "High" } catch {}
# The engine needs FOCUS until its first frame is actually rendered - stealing it earlier starves D3D and
# the level never presents (every probe missed). So: let the game keep focus through the load; the moment
# Wait-Ready below confirms a live frame, the window is parked in the corner and focus goes back to the
# user. The harness only ever runs when no user client exists, so this focus window (~15-25 s) is idle time.
$deadline = (Get-Date).AddSeconds($Wait)
$h = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 250
  # Keep RE-reading the handle: the first window is the splash screen, and a handle grabbed in the first
  # seconds goes stale when the real game window replaces it - every PostMessage then lands nowhere.
  $pp = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
  if ($pp) { $pp.Refresh(); if ($pp.MainWindowHandle -ne 0) { $h = $pp.MainWindowHandle } }
}
if ($h -eq [IntPtr]::Zero) { "no game window"; exit 1 }
# Park the game SMALL in the bottom-right corner, on screen and un-activated - unfocused, it never captures
# the cursor, keeps rendering, and PostMessage input still lands.
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
[Key]::SetWindowPos($h, [IntPtr]::Zero, $wa.Right - 830, $wa.Bottom - 650, 820, 640, 0x0014) | Out-Null   # NOZORDER|NOACTIVATE
if ($userWin -ne [IntPtr]::Zero) { [Key]::SetForegroundWindow($userWin) | Out-Null }

$here = Split-Path $MyInvocation.MyCommand.Path
# 20 probes ~ 70 s: a 50 MB city tile on a busy disk takes well past the old 8-probe window.
if (-not (Wait-Ready $h $outDir $here 20)) {
  "map never became playable - aborting"
  Get-Process -Id $proc.Id -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  exit 2
}
# The level start can re-grab focus; give it back to the user once more before driving the view.
if ($userWin -ne [IntPtr]::Zero) { [Key]::SetForegroundWindow($userWin) | Out-Null }

foreach ($c in $Cmd) {            # User.ini: Tilde=ConsoleToggle
  Send-Key $h 0xC0; Start-Sleep -Milliseconds 500
  Send-Text $h $c; Send-Key $h 0x0D; Start-Sleep -Milliseconds 500
  Send-Key $h 0xC0; Start-Sleep -Milliseconds 400
}
if ($HoldVk -ne 0 -and $HoldMs -gt 0) { Hold-Key $h $HoldVk $HoldMs }
if ($PitchDy -ne 0) {
  # Pitch by key hold (PageUp/PageDown are LookUp/LookDown in the test SDK's User.ini): ~4 ms of hold per
  # unit of the old mouse-dy keeps existing call sites in the same visual ballpark. Negative = look up.
  Hold-Key $h ($(if ($PitchDy -lt 0) { $VK_LOOKUP } else { $VK_LOOKDN })) ([Math]::Min(3000, [Math]::Abs($PitchDy) * 4))
}

# Hold a movement key down for the whole burst: the artefact being hunted only shows while
# actually walking around, which a pre-burst Hold-Key does not reproduce.
if ($WalkVk -ne 0) { [Key]::PostMessage($h, 0x0100, [IntPtr]$WalkVk, [IntPtr]1) | Out-Null }
for ($i = 0; $i -lt $Shots; $i++) {
  if ($WalkVk -ne 0) { [Key]::PostMessage($h, 0x0100, [IntPtr]$WalkVk, [IntPtr]1) | Out-Null }
  # -Fast samples many more frames per second, which is how a rare per-frame artefact is caught at
  # all: at one shot a second a 1-in-80 flicker needs minutes of runs to show up once.
  if ($Fast) { Start-Sleep -Milliseconds 250 } else { Start-Sleep -Seconds $Gap }
  Send-Key $h 0x78                                     # F9 = engine "shot"
  if ($Fast) { Start-Sleep -Milliseconds 250 } else { Start-Sleep -Milliseconds 1500 }
  if ($TurnMs -gt 0) { Hold-Key $h $VK_TURNR $TurnMs } # End = TurnRight (User.ini) between shots
  # Key-driven sweep, no mouse: -TurnDx yaws (positive = right), -StepDy pitches (positive = down); the
  # magnitudes are the old mouse deltas, ~3 ms of key hold per unit.
  if ($TurnDx -ne 0) { Hold-Key $h ($(if ($TurnDx -gt 0) { $VK_TURNR } else { $VK_TURNL })) ([Math]::Min(2500, [Math]::Abs($TurnDx) * 3)) }
  if ($StepDy -ne 0) { Hold-Key $h ($(if ($StepDy -gt 0) { $VK_LOOKDN } else { $VK_LOOKUP })) ([Math]::Min(2500, [Math]::Abs($StepDy) * 3)) }
}
Start-Sleep -Seconds 2

# The engine writes 24-bit BMPs with no row padding; GDI+ refuses them, so convert with our own
# reader (bmp2png.js) rather than System.Drawing.
$i = 0
foreach ($bmp in (Get-ChildItem "$sdk\Screenshots\*.bmp" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime)) {
  $file = Join-Path $outDir ("{0}_{1}.png" -f $Tag, $i)
  node "$here\bmp2png.js" $bmp.FullName $file $MaxW
  $i++
}
if ($i -eq 0) { "no screenshots written" }

# Close ONLY the client this run started; a client the user launched meanwhile is left alone.
$own = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
if ($own) { $own.CloseMainWindow() | Out-Null; Start-Sleep -Seconds 4; Get-Process -Id $proc.Id -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }
Remove-Item $pidFile -ErrorAction SilentlyContinue
(Get-Content "$sdk\System\KillingFloor.log" -ErrorAction SilentlyContinue | Select-String "^Critical:" | Select-Object -First 3) | ForEach-Object { "  CRIT $_" }
