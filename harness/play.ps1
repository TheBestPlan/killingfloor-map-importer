# Launch a map, drive the game by posting keys to its window (no desktop capture), take a burst of
# engine screenshots while turning the view, and convert them to PNG.
param([string]$Map = "KF-CS-Assault", [int]$Wait = 16, [string[]]$Cmd = @(), [string]$Tag = "play", [int]$MaxW = 700,
      [int]$Shots = 4, [int]$TurnMs = 700, [int]$Gap = 3, [int]$HoldVk = 0, [int]$HoldMs = 0, [int]$PitchDy = 0, [int]$TurnDx = 0, [int]$StepDy = 0, [switch]$Fast, [int]$WalkVk = 0)
$sdk = if ($env:KF_SDK_DIR) { $env:KF_SDK_DIR } else { throw "set KF_SDK_DIR to the Killing Floor install (the folder with System\KillingFloor.exe)" }
$outDir = if ($env:KF_SHOTS_DIR) { $env:KF_SHOTS_DIR } else { Join-Path $PSScriptRoot "shots" }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Key {
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@ -ErrorAction SilentlyContinue

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
    Start-Sleep -Milliseconds 1200
    $bmp = Get-ChildItem "$sdk\Screenshots\*.bmp" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($bmp) {
      $probe = Join-Path $outDir "_ready.png"
      node "$here\bmp2png.js" $bmp.FullName $probe 400 | Out-Null
      $verdict = node "$here\flat.js" $probe
      # A live view has detail; the loading fade and the lobby do not.
      if ($verdict -notmatch 'FLAT') {
        Remove-Item "$sdk\Screenshots\*.bmp", $probe -Force -ErrorAction SilentlyContinue
        return $true
      }
    }
    Start-Sleep -Seconds 2
  }
  return $false
}

Get-Process KillingFloor -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item "$sdk\System\KillingFloor.log", "$sdk\Screenshots\*.bmp" -Force -ErrorAction SilentlyContinue
Push-Location "$sdk\System"
Start-Process -FilePath ".\KillingFloor.exe" -ArgumentList "$Map.rom?Game=KFmod.KFGameType?QuickStart=1 -windowed -nosound" | Out-Null
Pop-Location
Start-Sleep -Seconds $Wait
$p = Get-Process KillingFloor -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { "no game window"; exit 1 }
$h = $p.MainWindowHandle

$here = Split-Path $MyInvocation.MyCommand.Path
if (-not (Wait-Ready $h $outDir $here 8)) { "map never became playable - aborting"; exit 2 }

foreach ($c in $Cmd) {            # User.ini: Tilde=ConsoleToggle
  Send-Key $h 0xC0; Start-Sleep -Milliseconds 500
  Send-Text $h $c; Send-Key $h 0x0D; Start-Sleep -Milliseconds 500
  Send-Key $h 0xC0; Start-Sleep -Milliseconds 400
}
if ($HoldVk -ne 0 -and $HoldMs -gt 0) { Hold-Key $h $HoldVk $HoldMs }
if ($PitchDy -ne 0) {
  # Relative mouse move to pitch the view (positive dy = look down). The game must have focus.
  [Key]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 400
  for ($k = 0; $k -lt 20; $k++) { [Key]::mouse_event(0x0001, 0, [int]($PitchDy / 20), 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 25 }
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
  if ($TurnMs -gt 0) { Hold-Key $h 0x27 $TurnMs }      # turn right between shots
  # Mouse look between shots: the only way to sweep the view, since no turn key is bound by
  # default. -TurnDx yaws, -StepDy pitches; both are relative moves and need the window focused.
  if ($TurnDx -ne 0 -or $StepDy -ne 0) {
    [Key]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 200
    for ($k = 0; $k -lt 10; $k++) {
      [Key]::mouse_event(0x0001, [int]($TurnDx / 10), [int]($StepDy / 10), 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 20
    }
  }
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

Get-Process KillingFloor -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }
Start-Sleep -Seconds 4
Get-Process KillingFloor -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
(Get-Content "$sdk\System\KillingFloor.log" -ErrorAction SilentlyContinue | Select-String "^Critical:" | Select-Object -First 3) | ForEach-Object { "  CRIT $_" }
