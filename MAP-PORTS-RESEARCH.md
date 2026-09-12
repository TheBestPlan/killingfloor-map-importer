# PUBG / DBD map ports & rips — research for a Killing Floor 1 import

Findings from a deep search across GameBanana, ModDB/IndieDB, NexusMods, Counter-Strike/GoldSrc
communities (17buddies, gamemaps), Steam Workshop, 3D-model sites (Sketchfab, CGTrader, Free3D,
Open3DLab, The Models Resource) and — for PUBG specifically — Roblox, the GTA family (GTA V/FiveM/MTA),
Arma 3, sandbox/sim games (Unturned, Ravenfield, BeamNG, Farming Sim), asset marketplaces (Fab/Unity
Asset Store, itch, ArtStation), VRChat/SFM, and browser shooters (Krunker). Minecraft is excluded on
purpose — its blocky voxel geometry is not worth porting.

**Headline:** the best real map geometry for **DBD** lives in GMod ports (Source BSP) and Open3DLab
(`.blend` with textures); plus a bonus — DBD's *licensed* realms (Midwich, Raccoon City) have GoldSrc
recreations the importer reads **directly**. **PUBG** has no full real rip (the UE4 statics are IP,
decryption-only), but there ARE usable parts: a GoldSrc **Sosnovka Military Base** that imports
directly, and free fan-built **POI models with real buildings** (Georgopol, Pochinki, Sanhok, Miramar)
— enough to assemble a KF map from parts on a heightmap terrain, rather than a whole-map rip.

## Path-to-KF legend

After the rollback, the importer reads only **GoldSrc BSP** and **Quake 3 BSP**.

- **★DIRECT** — GoldSrc/Q3 BSP, read as-is, no new code.
- **MESH** — Blender → export glTF/OBJ → a mesh front-end (the rolled-back glTF route, or an OBJ reader).
- **Source→MESH** — `.gma`/`.bsp` via Crowbar/BSPSource → Blender → glTF/OBJ → mesh front-end.

---

## Dead by Daylight — real map geometry

| Map | Host engine | Title / link | Format | Free | Type | KF path |
|---|---|---|---|---|---|---|
| **Macmillan Estate** (Coal Tower, Storehouse, Suffocation Pit, Ironworks) | GMod (Source) | «The Macmillan Estates (GMod Port)» Jmar — https://steamcommunity.com/sharedfiles/filedetails/?id=2416103532 | `gm_macmillanestates_edited.bsp` + DBD models | yes | rip-port, real assets | **Source→MESH** ★ best DBD |
| **Macmillan Estate** (full realm) | GMod (Source) | «Dead By Daylight — The Macmillan Estates» — https://steamcommunity.com/sharedfiles/filedetails/?id=2128911338 (delisted; Skymods mirror https://catalogue.smods.ru/archives/155684) | `.gma`→Source BSP + rip assets | yes | rip-port | Source→MESH |
| **Autohaven Wreckers** (all variants) | GMod (Source) | «Autohaven Wreckers» — https://steamcommunity.com/sharedfiles/filedetails/?id=2397044635 | `.gma`→Source BSP, navmesh/AI | yes | rip-port | Source→MESH ★ |
| **Hawkins National Laboratory** | GMod (Source) | https://steamcommunity.com/sharedfiles/filedetails/?id=2920342970 | `.gma`→Source BSP | yes | rip-port | Source→MESH |
| **Coldwind / Shelter Woods** | GMod (Source) | «gm_dbd_ShelterWoods» — https://steamcommunity.com/sharedfiles/filedetails/?id=2270400412 | `.gma`→Source BSP + assets | yes | rip-port | Source→MESH |
| **Mount Ormond** | GMod (Source) | «Mount Ormond — Last Man Standing» — https://steamcommunity.com/sharedfiles/filedetails/?id=2901971592 | `.gma`→Source BSP | yes | rip-port | Source→MESH |
| DBD in GMod (hubs/bundles) | GMod (Source) | ids 2849505396, 3543947380, 3681548135 | `.gma` | yes | collections | Source→MESH |

### DBD — Open3DLab (real rips, `.blend` + PBR textures) — often cleaner than GMod

| Map | Link | Format | Free | Contents | KF path |
|---|---|---|---|---|---|
| **Eyrie of Crows** (main building) | https://open3dlab.com/project/e43f74e9-75d1-4c99-a82f-d97ebf14a933/ | `.blend` 125MB + textures 285MB | yes | building + props | **MESH** ★ real geometry |
| **Ormond** (resort room) | https://open3dlab.com/project/ef5b06dc-53eb-4b18-9dd0-f0fc637f7a5a/ | `.blend` + textures | yes | interior, furniture, props | MESH |
| **Archives Room** | https://open3dlab.com/project/38573/ | `.blend` | yes | interior | MESH |
| **DBD props + vegetation** (full set) | https://open3dlab.com/project/be75c00d-9cad-42d9-852a-3c866800fa67/ | `.blend` + 1GB textures | yes | props/vegetation | MESH (populate maps) |
| **Killer Shack** (iconic shack) | Sketchfab Fen1xTon — https://sketchfab.com/3d-models/killer-shack-dead-by-daylight-278e1cbeb25141939708c8b213838cce | glTF/GLB, low-poly | yes | shack | MESH ★ simple |

### DBD — licensed realms via their origin franchise (GoldSrc = direct import!)

| DBD realm | = from | Engine | Title / link | Format | KF path |
|---|---|---|---|---|---|
| **Midwich Elementary** | Silent Hill | CS 1.6 (GoldSrc) | `dm_midwich` — https://gamebanana.com/mods/82622 | GoldSrc BSP | **★DIRECT** |
| **Midwich** | Silent Hill | CS:S (Source) | `zm_midwich_1f_final` — https://gamebanana.com/mods/132372 | Source BSP | Source→MESH |
| **Midwich** | Silent Hill | Doom II/GZDoom | «Silent Hill 5to2» — https://www.moddb.com/games/doom-ii/addons/silent-hill-5to2 | Doom WAD | convert |
| **Raccoon City Police (RPD)** | Resident Evil 2 | Half-Life (GoldSrc) | «Resident Evil Valiant» — https://www.moddb.com/mods/resident-evil-valiant | GoldSrc BSP | **★DIRECT** |
| **Raccoon City Police (RPD)** | Resident Evil 2 | L4D (Source) | `l4d_residentevil_rpd` — https://gamebanana.com/mods/141053 | Source BSP | Source→MESH |
| **RPD / Raccoon** | Resident Evil | Source (HL2) | «Biohazard Project» https://www.moddb.com/mods/biohazard-project · «Fall of Raccoon City» https://www.moddb.com/mods/resident-evil-fall-of-raccoon-city | Source BSP | Source→MESH |

---

## PUBG — no full real rip; assemble from parts

No real full-scene rip of PUBG geometry exists anywhere (the game's UE4 statics are IP, only reachable
by decrypting the paks — blocked). But two useful classes DO exist: **GoldSrc POI maps that import
directly**, and **fan hand-built POI models (Georgopol, Pochinki, Miramar, Sanhok) with real building
geometry** — enough to assemble a KF map from parts + a heightmap terrain.

### PUBG — GoldSrc BSP (★DIRECT import, no new code)

| Map / POI | Host | Title / link | Format | Type | KF path |
|---|---|---|---|---|---|
| **Sosnovka Military Base** (Erangel POI) | Half-Life | `PUBG_Military_Base` (WIP) — https://gamebanana.com/mods/482410 | GoldSrc BSP | fan, faithful POI | **★DIRECT** ★ best for pipeline |
| PUBG island (Erangel-style, not 1:1) | CS 1.6 | `playground_island` — https://gamebanana.com/projects/35282 | GoldSrc BSP | fan, WIP | **★DIRECT** |
| PUBG TDM arena | CS 1.6 | `pubg_tdm_v1` — https://gamebanana.com/mods/293161 | GoldSrc BSP | fan | **★DIRECT** |

### PUBG — POI 3D models with real buildings (fan hand-built; best for assembling a map)

| POI | Title / link | Format | Price | Buildings | KF path |
|---|---|---|---|---|---|
| **Georgopol** (city: warehouses/containers) | CGTrader — https://www.cgtrader.com/free-3d-models/industrial/other/pubg-georgopol-map | OBJ/FBX likely, ~170k tris | **free** | yes | **MESH** ★ |
| **Pochinki** (town, geometry only) | Sketchfab Doraimon — https://sketchfab.com/3d-models/pubg-pochinki-ceaae7c24fb2469d956ad15622f1470f | glTF/GLB, 464k tris | **free** (no textures) | yes | MESH ★ |
| **Miramar** (whole map, town massing) | Sketchfab GreyHorn102 — https://sketchfab.com/3d-models/miramar-pubg-8bd61821280c478b8f14fdf7025f4e20 | glTF/GLB, 1.3M tris | free (CC-BY) | some | MESH — inspect |
| Pochinki (game-ready) | CGTrader — https://www.cgtrader.com/3d-models/exterior/cityscape/pubg-pochinki-3d-map | MAX/OBJ/FBX/BLEND/unity | paid | yes | MESH |
| Pochinki | Free3D — https://free3d.com/3d-model/pubg-pochinki-map-666.html | .blend/.fbx/.max/.obj | ~$6 | yes | MESH |
| Pochinki | Sketchfab MOSAMIM.AMAR — https://sketchfab.com/3d-models/pubg-pochinki-map-7a650511802a479db226b4096930a720 | glTF, 832k tris | ~$5 off-platform | likely | MESH |
| **Sanhok — Paradise Resort** | Sketchfab angelzal — https://sketchfab.com/3d-models/pubg-mobile-sanhok-paradise-resort-1-6e2c7a305fcb470fa943d9c07b43cd1f | glTF/GLB, 42k tris | **free** | yes (resort) | MESH |
| Sanhok — Raised Hangar | itch justblendout — https://justblendout.itch.io/sanhok-raised-hangar-pubg | FBX/GLB/OBJ/BLEND, 4K PBR | $12 | yes (hangar) | MESH, high quality |
| PUBG School (building) | CGTrader — https://www.cgtrader.com/3d-models/exterior/house/pubg-school-building | FBX/BLEND | mostly paid | yes | MESH |
| Erangel terrain (OBJ) | Open3DModel — https://open3dmodel.com/3d-models/terrain-map-for-pubg_349030.html | C4D/DAE/MAX/OBJ | free | no (terrain) | MESH, low detail |

### PUBG — Source / Source 2 (decompile → mesh)

| Map / POI | Host | Title / link | Format | Type | KF path |
|---|---|---|---|---|---|
| **PUBG School** (Pochinki schoolhouse) | CS2 (Source 2) | https://steamcommunity.com/sharedfiles/filedetails/?id=3343693110 | `.vpk`/BSP v25 | faithful POI | Source2→MESH (Source2Viewer/VRF → glTF) |
| De_Pubg (PVP arena) | GMod (Source) | https://steamcommunity.com/sharedfiles/filedetails/?id=2844543868 | `.gma`→Source BSP | inspired | Source→MESH |
| pubg_dust2 | CS:S (Source) | https://gamebanana.com/maps/209077 | Source BSP | inspired | Source→MESH |
| PUBG Mobile BR · dm_royale · Royal_pubg | CS2 (Source 2) | Steam 3670050075 · 3637327357 · 3485838572 | `.vpk` | inspired BR | Source2→MESH |
| BR arenas for CS:GO (several) | Source (CS:GO) | gamebanana 78869, 81904, 81947; Steam 1208951722 | Source BSP | inspired BR | Source→MESH |

### PUBG — whole-map "meshes" (terrain + procedural boxes — low value)

| Map | Title / link | Format | Notes |
|---|---|---|---|
| Erangel | Sketchfab burunduk — https://sketchfab.com/3d-models/map-pubg-erangel-be795adb61e843aeb2ddb13aab58724a | glTF/OBJ, 328k tris | terrain (from heightmap) + rectangle-spline boxes, no real buildings |
| Erangel | Sketchfab GreyHorn102 — https://sketchfab.com/3d-models/erangel-pubg-3c86b890b007442c9f8695cb777a0114 | glTF, 131k tris | terrain-scale, minimal detail |
| Erangel/Miramar/Sanhok/… terrain | cgcostume/pubg-maps — https://github.com/cgcostume/pubg-maps | 16-bit height + normal PNG | real ripped elevation, no buildings (already tried — bare terrain is junk on its own) |

### PUBG — Unity-based (need AssetRipper → FBX)

| Map | Host | Title / link | Type | Notes |
|---|---|---|---|---|
| **Erangel** (POIs named: Pochinki, Rozhok, Sosnovka Mil.) | Unturned | https://steamcommunity.com/sharedfiles/filedetails/?id=973918191 | semi-faithful | REMOVED from Workshop; Unity assets → AssetRipper → FBX |
| Erangel | Unturned | Steam 1144432583 · 1124835896 | inspired arena | Unity rip |
| Erangel | Ravenfield | https://steamcommunity.com/sharedfiles/filedetails/?id=2038419771 | inspired | REMOVED; Unity assetbundle rip |
| PUBG_BYOL | Contractors VR | https://mod.io/g/contractors/m/pubg-byol | inspired | Unity assetbundle rip |

### PUBG — Krunker (browser, JSON scene → OBJ)

| Map | Host | Where | Type | KF path |
|---|---|---|---|---|
| Erangel / Pochinki community maps | Krunker.io | krunker.io editor/social (no stable public URL) | inspired, blocky | Krunker editor → export OBJ, or map JSON → converter → glTF |

**PUBG dead-ends (searched, nothing usable):** Arma 3 / DayZ (PLAYERUNKNOWN's BR mod is gamemode-only on
stock islands — no Erangel terrain); GTA V / FiveM / MTA:SA / SA-MP (BR gamemode scripts on GTA's own
map + skins/weapons, no Erangel geometry); Roblox (many BR games, all copylocked → no export); BeamNG,
Farming Simulator, Teardown, Pavlov VR, Blade & Sorcery (nothing); SFM / VRChat / Open3DLab / DeviantArt
(no map files — Source can't hold PUBG's 8×8 km scale); Sven Co-op, Zombie Panic Source, OpenArena /
Xonotic, Point Blank, Warface, Standoff 2 (nothing). No 1:1 faithful Erangel/Miramar full map exists in
any exportable engine — only the POI models above plus generic BR arenas.

_Caveat: several agents hit the session's 200-call web-search cap, so a few corners (Fab/Unity Asset
Store deep, VRChat, some CGTrader/TurboSquid pages behind JS) are "not found via available tooling"
rather than proven empty._

---

## Verdict & what to take

1. **DBD wins.** For real maps take:
   - **Open3DLab** (Eyrie of Crows, Ormond, Archives + props) — real building geometry with textures in
     `.blend`, cleanest. Path: Blender → glTF/OBJ → mesh front-end.
   - **GMod ports** (Macmillan `gm_macmillanestates_edited.bsp`, Autohaven, Hawkins) — full realms. Path:
     `.gma`→Crowbar/BSPSource→Blender→glTF/OBJ.
2. **Bonus, no new code:** DBD's Midwich and Raccoon City realms exist as **GoldSrc BSP**
   (`dm_midwich`, «Resident Evil Valiant») — the importer reads them **right now** (`--game cs`); worth
   trying first.
3. **PUBG:** no full 1:1 rip, but assemble from parts:
   - **`PUBG_Military_Base`** (GoldSrc) — imports **★directly**, faithful Sosnovka POI. Fastest PUBG win.
   - Free POI models with real buildings — **Georgopol** (CGTrader, free), **Pochinki** (Sketchfab
     Doraimon, free), **Sanhok Paradise Resort** (free), **Miramar** whole-map (GreyHorn102, 1.3M) —
     drop onto a `cgcostume` heightmap terrain via a glTF/OBJ front-end.
   A whole faithful Erangel with real statics = unpacking the game only (decryption, out of scope).

**Tool note:** after the rollback the importer reads only GoldSrc/Quake 3 BSP. Every "MESH" option
(Open3DLab, GMod) needs a **glTF/OBJ mesh front-end** — the one that was rolled back (it was the right
tool, just fed heightmap junk). Pick a source and it's either a direct GoldSrc import or a rebuilt
glTF/OBJ reader aimed at the chosen real map (Open3DLab / GMod).
