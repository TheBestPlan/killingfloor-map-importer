# Killing Floor Map Importer

**English** · [Русский](./docs/translations/README.ru.md) · [Español](./docs/translations/README.es.md) · [Português](./docs/translations/README.pt.md) · [Lietuvių](./docs/translations/README.lt.md) · [Polski](./docs/translations/README.pl.md) · [Français](./docs/translations/README.fr.md) · [中文](./docs/translations/README.zh.md) · [日本語](./docs/translations/README.ja.md)

Imports maps from other games into **Killing Floor 1** as real `.rom` levels (Unreal Engine 2.5, file version 128 / licensee 29). The package is written from scratch — no KFEd, no intermediate formats, no manual steps: point it at a map file and get a `.rom` you can drop into `KillingFloor\Maps` and play.

The source engine today is **GoldSrc BSP v30** — Counter-Strike 1.6, Half-Life and their mods. Reading the source game is a single module (`src/goldsrc/`) behind a shared build-and-write pipeline, and more games are the planned way for this to grow — see [Roadmap](#roadmap-more-source-games).

> The Unreal side was reverse-engineered by hand. The `UModel` v128 serialization order and the layout of the baked lightmaps inside it are documented nowhere else, and no public GoldSrc → Unreal converter exists. The write-up is in [`docs/RESEARCH.md`](./docs/RESEARCH.md); every pitfall that cost time is in [`docs/GOTCHAS.md`](./docs/GOTCHAS.md).

## Status

| Capability | State |
| --- | --- |
| Geometry, textures, collision, player starts | working — played in the real client |
| Sky — the map's six real `gfx/env` images on a skybox cube | working |
| Water — swimming, screen tint, layered textures | working |
| Sprites (`.spr`) and props (`.mdl`) | working |
| Doors and breakable glass | working — `KFDoorMover` + `KFUseTrigger`, `KFGlassMover` |
| Baked lighting | partial — luxels are read and packed into DXT3 atlases, but the client draws flat zone ambient (see [What is missing](#what-is-missing)) |
| Zones / PVS occlusion, bot paths, buttons and triggers | not done |

## What you need

- A **Killing Floor 1** install (or the non-Steam SDK) — that is where the finished `.rom` goes.
- A **Counter-Strike 1.6 / Half-Life** install — the stock `.wad` texture archives and the `gfx/env` skyboxes live there. A downloaded map is usually the `.bsp` on its own and needs them; without them every texture comes out magenta and the map has no sky.
- **Node.js ≥ 18** for the CLI. The desktop app needs nothing extra.

No game content ships with this repo, in either direction. You point it at your own installs.

## Desktop app (Windows / macOS / Linux)

Prebuilt, self-contained apps are on the [Releases](https://github.com/geekrainian/killingfloor-map-importer/releases) page:

- **Windows** — `…-setup.exe` (installer) or `…-portable.exe` (run without installing).
- **macOS** — `…-mac-x64.dmg` (Intel) or `…-mac-arm64.dmg` (Apple Silicon).
- **Linux** — `…-linux-x86_64.AppImage` (run anywhere) or `…-linux-amd64.deb`.

Drop `.bsp` files onto the window, pick the output folder and the Counter-Strike folder, press Convert. Each map is converted in a child process, so a crash or a huge map cannot take the window down with it. The builds are unsigned, so the OS may warn on first launch (Windows SmartScreen → *More info → Run anyway*; macOS → right-click → *Open*).

### Build it yourself

```bash
pnpm install
pnpm start          # run the app from source
pnpm run dist       # build installers for the current OS into dist/
```

## CLI

```bash
node src/cli.js "…/cstrike/maps/cs_assault.bsp" --out "…/KillingFloor/Maps" \
     --name KF-CS-Assault --cs-dir "…/Counter-Strike 1.6" --verify
```

| Option | Default | What it does |
| --- | --- | --- |
| `--out <file\|dir>` | next to the `.bsp` | where to write the `.rom` |
| `--name KF-Xxx` | `KF-<bsp name>` | map name inside the package |
| `--scale <n>` | `1.9` | GoldSrc units → Unreal units |
| `--lightmap-scale <n>` | `32` | luxel size in Unreal units |
| `--cs-dir <dir>` | — | Counter-Strike 1.6 client folder: stock `.wad`s, `gfx/env` skies, `sprites/*.spr` |
| `--wad <dir>` | map folder and two above it | extra folders to search for `.wad` files |
| `--geometry mesh\|bsp\|both` | `mesh` | what draws the world: static meshes, the BSP, or BSP with meshes as collision only |
| `--verify` | off | read the finished `.rom` back with an independent reader and check its invariants |
| `--no-spawns` | off | do not carry over player starts |
| `--no-swim` | off | drop the swimming physics from water, leaving only the underwater tint |
| `--health-scale <n>` | `1` | multiply every breakable's health — CS walls are often 10 HP, which is one shot in KF |
| `--light-scale <n>` | `1` | multiply the sun and every lamp — the knob for tuning a build without editing the map |
| `--lighting <mode>` | `ambient` | `ambient` — the zone lights the level, plays as converted. `sunlight` — a `Gameplay.Sunlight` and almost no ambient, for a `Build Lighting` pass in KFEd. `dynamic` — the map's own lights, live, no build. `lightmap` — GoldSrc's baked light carried across as a texture: shadows, half-tones and colour as the original has them |
| `--ase` | off | also emit `.ase` / `.t3d` (backend B, for hand-finishing in KFEd) |

Diagnostic switches, kept on purpose: `--stock-sky "Pkg.Group.Name"`, `--no-sky`, `--no-extras`, `--no-light`, `--tree-translate`, `--spawn-index N`, `--bare` (level scaffolding and player starts only — for bisecting what KFEd chokes on, not playable). `KF_SPAWN_AT="x,y,z[,yaw]"` in the environment replaces every player start with one at that point — the way to land where the thing you want to look at is.

## What transfers

| | How |
| --- | --- |
| world geometry | static meshes, one material per mesh, sliced on a 2048 UU grid, reverse-wound (the Y mirror flips triangle orientation); collision is their kDOP tree |
| brush entities (`func_wall`, `func_illusionary`, `func_ladder`…) | the same way, honouring the entity's `origin` key |
| doors (`func_door`, `func_door_rotating`) | `KFMod.KFDoorMover` + `KFMod.KFUseTrigger` — opened with the use key and weldable like a native KF door; `KeyPos`/`KeyRot` from `angle`/`lip`/`distance` |
| breakables (`func_breakable`, any material) | `KFMod.KFGlassMover` with the entity's `Health`, one actor and one mesh each so they can be shot away or deleted; glass also gets `Style = STY_Translucent`, everything else loses the glass shards |
| water (`func_water`) | translucent top plane plus a `PhysicsVolume` with a real brush box: swimmable, but standing 110 uu clear of the bottom so zeds — which cannot swim — keep walking through it |
| sprites (`env_sprite`, `env_glow`, `cycler_sprite`) | `Engine.Effects` billboards, additive or alpha by the `.spr` texture format |
| props (`.mdl` on the same entities) | static mesh in bind pose plus one actor per instance; skins from the model or from `<name>T.mdl` |
| textures | 8-bit miptex → `UTexture` P8 + `UPalette` **without re-encoding**; GoldSrc's 4 mips are continued by point sampling down to 1×1 |
| masked textures (`{name`) | palette permuted so the transparent index moves from 255 to 0, `PF_Masked` |
| sky | six `gfx/env/<skyname>*` images → DXT1 on a skybox cube (RGBA8 was two thirds of a converted map: 1.33 MB a face against 0.13 MB); `sky` faces are cut out of the meshes; no `skyname` falls back to the engine's `desert` |
| lighting | four routes, see `--lighting`. The faithful one packs the map's own luxels into 512×512 atlas pages and multiplies them into the texture through a second UV channel, so the shadows and half-tones are the ones hlrad baked twenty years ago |
| player starts | `info_player_start` / `info_player_deathmatch` → `PlayerStart`, lifted onto the floor |
| scale | ×1.9 by default (×2 is what the shipped `KF-CS-*` ports measure at, and it lands GoldSrc's 16-unit luxel grid exactly on UE2.5's 32 UU one) |

Faces that do not make it are the invisible tool textures — `aaatrigger`, `clip`, `null`, `hint` — which have no business in the world: 48 of 3206 on cs_assault, 25 of 5383 on de_dust2, 36 of 8528 on cs_italy.

## What is missing

- **Baked shadows.** GoldSrc luxels are sampled and written, but the client does not apply them at runtime, so lighting is flat — zone ambient derived from the map's own luxels. Likely wants a `Build Lighting` pass in KFEd.
- **Zones.** Always two (0 = solid, 1 = the world), so there is no PVS occlusion: everything is drawn. Fine at Counter-Strike map sizes.
- **Bot paths.** `PathNode` / `ReachSpec` are not generated — needs a `Build Paths` pass in KFEd.
- **Buttons and trains.** `func_button`, `trigger_*` and `func_train` stay static geometry.
- **Animated textures** are carried as frame 0; `-0` (random tiling) becomes an ordinary texture.
- **Non-power-of-two textures** are resampled to the nearest power of two (UE2.5 sizes the buffer from `UBits` and corrupts the heap otherwise). Texture axes are scaled by `pot/orig`, so UVs do not drift.

## Roadmap: more source games

The pipeline is split so that the source game is the only part that changes: `src/goldsrc/` reads the map, `src/build/` turns it into Unreal structures, `src/unreal/` writes the package. Adding a game means a new reader that produces the same intermediate shape — faces with UVs, textures, entities, a lightmap grid — and nothing under `src/unreal/` has to move. Quake / Quake II / Source-engine BSP variants are the obvious next candidates, since they are the same family of formats and land on the same `UModel` writer.

Contributions in that direction are welcome; start with [`docs/RESEARCH.md`](./docs/RESEARCH.md) for the target format and [`docs/GOTCHAS.md`](./docs/GOTCHAS.md) for the invariants that must not be broken.

## How it is verified

```bash
pnpm test          # node test/selfcheck.js
```

19 checks, all green. The load-bearing ones:

- the `UModel` v128 serializer re-writes **41 shipped Killing Floor maps byte for byte** (the only differences are signalling-NaN payloads that JS normalises);
- compact index and `FString` round-trip;
- across 25 Counter-Strike maps: the computed lightmap footprint fits the `LIGHTING` lump, face winding is `Newell == −normal`, face vertices lie on the face plane;
- every shipped `UPolys` object fits the layout exactly (6054 objects, 37136 polys, 0 mismatched);
- the DXT3 encoder, the `.mdl` and `.spr` readers, the Lanczos resampler.

Game files are found from the usual Steam locations; without them those checks fail loudly rather than passing empty, so run `pnpm test` on a machine that has the games (CI only smoke-tests packaging).

`--verify` re-reads the finished `.rom` with an independent reader and checks 22 invariants: header, tables, serial ranges, reference resolution, unit-length node planes, vertices on their plane, winding, sections mirroring node polygons, lightmap ranges and UVs inside the atlas, well-formed DXT3, the tree actually being a tree, and a full mip chain on every texture. Measured, all clean:

```
cs_assault  3206 faces -> 7247 tris in 323 meshes   149 textures  13.41 MB
de_dust2    5383 faces -> 9932 tris in 229 meshes    36 textures  12.05 MB
cs_italy    8528 faces -> 21038 tris in 396 meshes   89 textures  16.35 MB

cs_assault --geometry bsp   3158/3206 faces (98.5%)  3570 nodes  3569 lightmaps  5 atlases  14.90 MB
```

`test/repack.js <map.rom>` rebuilds an existing map with the same writer and compares bytes: on `KF-CS-Iceworld` the difference is **one byte** (`packageFlags`). `test/render-test.ps1` launches the client straight into a map, bypassing the lobby, and rules on `Critical:` lines in `KillingFloor.log`. `KF-CS-Assault` has been run from all 20 player starts with no `Critical`.

**Not covered by tests:** how the map looks in the KFEd 3D viewport (its own render path), and whether the picture is *correct* — the tests catch crashes, not artefacts.

## Checking a map in the game

[`harness/play.ps1`](./harness/README.md) launches the client into a map, drives the console with `PostMessage`, takes screenshots with the engine and converts them to PNG; `harness/flat.js` judges frames by edge density (18–30 % is normal, ~1.4 % is a frame where the world did not draw). The rule that matters: **a negative render result is worthless until the harness itself is proven** on a case known to work. Details and traps in [`harness/README.md`](./harness/README.md) and [`docs/GOTCHAS.md`](./docs/GOTCHAS.md) §7.

## Layout

```
killingfloor-map-importer/
├─ src/
│  ├─ cli.js                CLI front end
│  ├─ convert.js            the whole pipeline
│  ├─ verify.js             invariant checks on a finished .rom
│  ├─ resources.js          where to find .wad files and the gfx/env sky
│  ├─ backendB.js           backend B: .ase (mesh + light in vertex colours) + .t3d + 8-bit BMPs
│  ├─ goldsrc/              source game: bsp.js, wad.js, mdl.js, spr.js, skybox.js
│  ├─ build/                GoldSrc → Unreal: model.js, mesh.js, brushents.js, propmesh.js, skybox*, upscale.js
│  └─ unreal/               package writer: package.js, writer.js, model.js, staticmesh.js, polys.js,
│                           texture.js, dxt.js, read.js (independent reader used by --verify)
├─ electron/                desktop app: main, preload, renderer, worker (conversion in a child process)
├─ test/                    selfcheck.js (pnpm test), repack.js, render-test.ps1
├─ harness/                 play.ps1, flat.js, bmp2png.js — looking at a map in the real client
├─ scripts/                 research tools used to work the formats out (see docs/RESEARCH.md)
└─ docs/                    RESEARCH.md, GOTCHAS.md, translations/
```

## Documentation

- **[docs/RESEARCH.md](./docs/RESEARCH.md)** — the format research: what was measured on both sides, the `UModel` v128 serialization order, the three possible architectures and why this one, how the existing `KF-CS-*` ports were actually made.
- **[docs/GOTCHAS.md](./docs/GOTCHAS.md)** — every measured pitfall, including the five invariants whose violation crashes the engine. Required reading before changing the writer.
- **[harness/README.md](./harness/README.md)** — checking a converted map in the real client.

## Legal

Converting a map does not give you the right to publish it. Valve permits moving assets between games in non-commercial mods but asks that **vanilla maps not be ported verbatim**; Tripwire requires that mods carry no third-party protected property without written permission and stay free. Both public Killing Floor ports of Counter-Strike maps (`KF-Dust_1`, `KF-Assault`) were removed from the Steam Workshop. Custom maps belong to their authors, not to Valve — permission is theirs to give.

This importer ships no game content and produces nothing on its own: what it writes is derived from the map you feed it, and where that output may go is between you and whoever owns the source map.

## Disclaimer

A personal reverse-engineering and format-interoperability project, published for research and educational purposes. Reverse-engineering the engine's package format may run against the game's EULA — you alone are responsible for how you use this code. Provided **as is**, without any warranty (see the license). Not affiliated with Tripwire Interactive, Epic Games or Valve.

## License

Copyright (c) 2026 Geekrainian.

Released under the **GNU General Public License v3.0 or later** (GPL-3.0-or-later). See [LICENSE](./LICENSE) for the full text. This program is free software: you can redistribute it and/or modify it under those terms, and it comes with **no warranty**.

## Trademark notice

Killing Floor and Unreal are trademarks of Tripwire Interactive and Epic Games; Counter-Strike, Half-Life and GoldSrc are trademarks of Valve. This is an unofficial, fan-made tool, not affiliated with or endorsed by any of them.
