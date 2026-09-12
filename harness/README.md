# Harness: looking at a map with nobody at the keyboard

Tools for checking converted maps in the **game**. The editor cannot be checked this way — KFEd does
not open a map from the command line, so that is always a manual look.

The full list of traps is in [`../docs/GOTCHAS.md`](../docs/GOTCHAS.md), section 7. Short version
here.

## Running it

```powershell
# build the map and take three frames, turning the view between them
.\play.ps1 -Map KF-CS-Assault -Wait 10 -Shots 3 -Gap 3 -TurnMs 1400 -Tag test

# with console commands (third person shows the ground around the player fastest)
.\play.ps1 -Map KF-CS-Assault -Cmd @("behindview 1") -Shots 2 -Tag view

# reconvert the map before launching
.\play.ps1 -Map KF-CS-Assault -Convert -Flags @("--verify") -Tag rebuild
```

PNGs land in `shots/`, with the frame's mean brightness printed next to each.

## Why it works this way

- **The engine takes the screenshot, not the desktop.** `F9` is bound to `shot` in `User.ini` and the
  frame lands in `<SDK>\Screenshots\*.bmp`. Capturing the screen with `CopyFromScreen` captures
  whatever Windows considers the top window, which because of the foreground lock is often not the
  game.
- **The engine's BMPs are 24-bit with no row padding, and GDI+ will not open them.** In a script that
  looks exactly like "the frame is empty" — which is how the false conclusion "the meshes are not
  drawing" got made three times. So conversion goes through `bmp2png.js` and its own reader:
  `stride = width*3` when the file is smaller than the aligned size.
- **Keys are sent to the game window with `PostMessage`** — no focus needed and the mouse is not
  hijacked. The console is on `VK_OEM_3` (0xC0); Tab is not bound. Close the console afterwards or it
  eats F9.
- **The lobby is skipped with `?QuickStart=1`**, otherwise the client sits on the ready screen drawing
  nothing — while the log stays clean.
- **A map with no `ZombieVolume` ends itself in about 15 seconds** and moves to the next one: a late
  frame will show a different level.

## The rule that matters

**A negative result does not count until the harness itself has been proven.** Before believing that
something is not drawing, shoot a case known to work with the same script — a stock KF map, or this
same map one step earlier.

## Getting to where the interesting thing is

The harness cannot walk. Instead the converter understands `KF_SPAWN_AT="x,y,z"` (Unreal units, after
the Y mirror): every `PlayerStart` is replaced by a single one at that point.

```powershell
$env:KF_SPAWN_AT = "243,-1946,80"     # middle of the pool; the converter prints candidates itself
node ..\src\cli.js <map.bsp> --out <SDK>\Maps --name KF-WaterTest
Remove-Item Env:\KF_SPAWN_AT
.\play.ps1 -Map KF-WaterTest -Shots 2 -Tag water
```

Water is checked the same way: the underwater screen tint appears exactly when the pawn is inside a
`PhysicsVolume` with `bWaterVolume` — there is no other way to see that the volume worked.

## Frames where the world does not draw

They are triggered by **view direction** — not by position, not by walking, not by time. Look up, but
not all the way: about 30 degrees short of vertical, diagonally. Holding that pitch, sweep the view
smoothly through a full circle. Somewhere in the turn the world disappears and stays gone while the
view is there.

Before that, make sure the level is actually running: the game window appears long before the map has
loaded and the player has spawned. A short `-Wait` ruins the whole run — the frames come from the
loading fade or the lobby, every one of them reads as empty, and the bug looks either always present
or never. `play.ps1` now takes a probe frame itself and waits for a live first-person view with a HUD
(`Wait-Ready`), failing with `map never became playable` instead of producing a run full of false
positives.

Hence the parameters: partial pitch (`-PitchDy` around -500, not -2000) and yaw in small steps with a
frame after each — that is `-TurnDx` together with `-Fast`:

```powershell
.\play.ps1 -Map KF-CS-Assault -Wait 12 -Shots 30 -PitchDy -500 -TurnDx 220 -MaxW 500 -Fast
```

Judge the frames with `flat.js`: it measures edge density in the left part of the frame, away from the
weapon and the HUD. Normal is 18–30 %, a failure is around 1.4 %.

```powershell
node flat.js <folder with shots>\*.png
```

Mean brightness **cannot** be used to judge: a dark wall right in front of you gives the same number
as a blank frame, and the first frames of a run are 0.0 from the loading fade.
