# Render test. Launches the KF client straight into the map with a game type that has no lobby /
# ready-up, so the level is actually drawn without anyone touching the window. The verdict comes
# from the log ("Critical:" lines), not from whether the process happens to still be alive.
param([string[]]$Flags = @(), [string]$Map = "", [switch]$SkipConvert)
$sdk = if ($env:KF_SDK_DIR) { $env:KF_SDK_DIR } else { throw "set KF_SDK_DIR to the Killing Floor install (the folder with System\KillingFloor.exe)" }
$tool = Split-Path -Parent $PSScriptRoot
$bsp = if ($env:CS_TEST_BSP) { $env:CS_TEST_BSP } else { throw "set CS_TEST_BSP to the .bsp to convert for the test" }
$name = if ($Map) { $Map } else { "KF-RT" }

if (-not $SkipConvert) {
  Push-Location $tool
  $conv = & node src/cli.js $bsp --out "$sdk\Maps" --name $name @Flags 2>&1
  Pop-Location
  $stat = ($conv | Select-String "model:") -replace '\s+', ' '
} else { $stat = "(existing map)" }

Remove-Item "$sdk\System\KillingFloor.log" -Force -ErrorAction SilentlyContinue
Push-Location "$sdk\System"
# Engine.GameInfo has no lobby: the pawn spawns and the world is drawn immediately.
$p = Start-Process -FilePath ".\KillingFloor.exe" `
     -ArgumentList "$name.rom?Game=$($env:RT_GAME)?Difficulty=1 -windowed -nosound" -PassThru
Pop-Location
$deadline = (Get-Date).AddSeconds(50)
while ((Get-Date) -lt $deadline -and -not $p.HasExited) { Start-Sleep -Milliseconds 1500 }
$alive = -not $p.HasExited
# Close politely so the engine flushes its log; a hard kill leaves the file empty.
if ($alive) {
  $p.CloseMainWindow() | Out-Null
  for ($i = 0; $i -lt 20 -and -not $p.HasExited; $i++) { Start-Sleep -Milliseconds 750 }
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 3

$log = Get-Content "$sdk\System\KillingFloor.log" -ErrorAction SilentlyContinue
$crit = $log | Select-String "^Critical:" | Select-Object -First 3
$drew = ($log | Select-String ("Bringing Level " + $name)) -ne $null
"FLAGS: $($Flags -join ' ')   MAP: $name"
"  $stat"
"  precached geometry: $drew   process alive at 55s: $alive"
if ($crit) { "  RESULT: CRASH -> " + (($crit -join ' | ') -replace '\s+', ' ') }
else { "  RESULT: no Critical in log" }
