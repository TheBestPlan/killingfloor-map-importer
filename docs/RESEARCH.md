# Converting Counter-Strike 1.6 maps to Killing Floor 1

**English** · [Русский](./translations/RESEARCH.ru.md)

A feasibility study of automatic GoldSrc BSP v30 → Unreal Engine 2.5 `.rom` conversion (geometry,
lighting, textures, collision, models), 2026-08-06.

---

> **Status: implemented.** Route C (writing the `.rom` directly) is written and works — see the
> repository root. `node src/cli.js <map.bsp> --out <Maps> --verify`. Face coverage on the test maps
> is 98.5–99.6 %, the `UModel` serializer is proven byte for byte against 41 shipped KF maps, and the
> finished maps load in the engine without a single `Critical`. The open items (collision, sky, bot
> paths) are listed in the [README](../README.md).

## 0. Verdict

**Possible. A fully automatic converter is buildable.** The blocker everyone treated as unsolvable —
the format of the baked BSP lighting inside `UModel` v128 — was opened up in the course of this study
and **validated on 362 maps out of 362**.

Three architectures, cheapest to most correct:

| # | Route | Lighting | Automation | Effort | Risk |
|---|---|---|---|---|---|
| A | BSP → `.t3d` brushes → KFEd → Build | relit from scratch | manual step in the GUI | 1–2 weeks | high (CSG chokes) |
| **B** | **BSP → tessellated StaticMesh (`.ase`) + lightmap in vertex colours → KFEd import** | **~1:1 through vertex colours** | **one manual step** | **3–5 days** | **low (28 working maps as precedent)** |
| C | BSP → writing the `.rom` directly (own UE2.5 serializer) | 1:1 into DXT3 atlases | full | 3–6 weeks | medium |

**Recommendation: start with B, evolve into C if needed.** B gives a working result in days and
follows the path that already produced 28 live `KF-CS-*` maps. C is the "right" target: the only
route that yields genuine BSP lightmaps, zones, portals and LeafHull collision — and it is no longer
blocked.

No route produces a map that is ready to play out of the box: bot paths (`PathNode` + `ReachSpec`),
the trader and the zombie volumes have to be built separately (a `PATHS BUILD` pass in KFEd, or a
generator of your own).

---

## 1. What was measured (own measurements, not literature)

### 1.1 The Counter-Strike 1.6 side

The BSP30 parser was written from scratch; the check is that the computed lightmap volume must match
the `LUMP_LIGHTING` lump:

| map | faces | lit faces | lightmap lump | textures | brush models |
|---|---|---|---|---|---|
| de_dust | 5550 | 4482 | 551 KB | 30 (all from WAD) | 48 |
| de_dust2 | 5383 | 4002 | 491 KB | 44 (15 embedded) | 43 |
| cs_office | 9384 | 8390 | 754 KB | 214 (101 embedded) | 206 |
| de_inferno | 9347 | 8587 | 1173 KB | 97 (all embedded) | 155 |
| cs_italy | 8528 | 7839 | 1014 KB | 102 (all from WAD) | 102 |

Computing `w = extents[0]/16 + 1`, `h = extents[1]/16 + 1`, `bytes = w*h*3*styles` gives
**4050 KB against 3983 KB actual — a ratio of 1.017**. The luxel grid formula is confirmed. None of
these five maps uses multi-layer (flickering) lightstyles at all, so the transfer is single-layer.

Special textures that occur and need their own handling: `sky`, `{name` (masked, palette index 255
transparent), `~name` (emitter), `+0name` (animation), `-0name` (random tiling), `aaatrigger`,
`hint`, `origin`.

Critical: **brush-entity vertices are stored in the entity's coordinate system**, so the world
position is `vertex + entity.origin` (hlcsg subtracts the origin brush at compile time).
`dmodel_t.origin` is zero throughout and cannot be relied on.

### 1.2 The Killing Floor side — `UModel` v128 opened up

The serialization order (the `Ver >= 110` branch), verified on **362 maps out of 362 — an exact hit
on `serialSize`, to the byte**:

```
[UObject props "None"] [FBox 25] [FSphere 16]
Vectors  TArray<FVector>
Points   TArray<FVector>
Nodes    TArray<FBspNode>     // v128: canonical + ExclusiveSphereBound + iSection, iFirstVertex, iLightMap
Surfs    TArray<FBspSurf>     // v128: ... + Plane(16) + LightMapScale(float, usually 32.0)
Verts    TArray<FVert>
INT NumSharedSides
INT NumZones ; FZoneProperties Zones[NumZones]   // {cidx ZoneActor, QWORD Conn, QWORD Vis, FLOAT}
cidx Polys
TArray<FBox>  Bounds          // 25 bytes per element
TArray<INT>   LeafHulls
TArray<FLeaf> Leaves          // {cidx iZone, cidx iPermeating, cidx iVolumetric, QWORD VisibleZones}
TArray<AActor*> Lights        // cidx per element
INT RootOutside ; INT Linked
TArray<FBspSection>     Sections       // FBspVertexStream(40 B/vertex) + Material + NumNodes + PolyFlags + iLightMapTexture
TArray<FLightMap>       LightMaps      // 7×cidx + FMatrix(64) + 3×FVector(36) + TArray<FLightBitmap> + cidx Level + INT Rev
TArray<FLightMapTexture> LightMapTextures
```

It was exactly the wrong assumption about this order — expecting `LightMap`/`LightBits` straight
after `Polys`, as in UE1 — that used to break the parse. In UE2.5 `FLightMapIndex`/`LightBits` is a
dead `Ver < 105` branch.

**What BSP lighting looks like in KF:**

| map | geometry | trailer | LightMaps | shadow bitmaps | atlases |
|---|---|---|---|---|---|
| Entry.rom | 1 KB | 321 KB | 0 | 0 | 1 × DXT3 512×512 (320 KB) |
| KF-CS-Action | 66 KB | 764 KB | 294 | 103 (1 KB) | 2 × DXT3 512×512 (640 KB) |
| KF-BioticsLab | 437 KB | 5546 KB | 1221 | 8911 (1656 KB) | 9 × DXT3 512×512 (2880 KB) |

So: **baked RGB lightmaps in 512×512 DXT3 atlases (2 mips, 320 KB per atlas) inside the `Model`
object itself**, plus one 1-bit shadow bitmap per contributing light source (for recomputing
switchable light at runtime). Geometry is 8–13 % of the map; the rest is light.

**This is format-compatible with GoldSrc**, which also bakes RGB. Transferring lighting 1:1 is
possible in principle — nobody has done it yet (no precedent for injecting a lightmap into UE2.x was
found).

### 1.3 Scale — measured against a working port

`cs_estate.bsp`: the world is 3016 × 3232 × 672 HL units.
`KF-CS-Estate-KFN.rom`, mesh `csestate`: 2832 × 2976 × 616 locally at **DrawScale = 2.0**.

**The porters used ×2.** A side effect worth understanding: HL's luxel grid is 16 units; ×2 = 32 UU =
exactly the default `LightMapScale` in UE2.5. At scale 2, GoldSrc luxels land on Unreal's lightmap
grid **one to one, with no resampling**.

The proportionally "correct" scale is a different number: the HL player is 32×32×72, KF's
`KFHumanPawn` is radius 20, half-height 50 (100 UU). By height that is ×1.39. At ×2 the player is
44 % smaller relative to the geometry than in Counter-Strike, so doors and corridors get roomier. For
KF (6 players plus a crowd of zeds) that is more of a plus, and it is how the live maps are made. The
discrepancy is deliberate, not a mistake.

What ×2 breaks and needs fixing by hand:

- jumping: `JumpZ=325` under gravity −950 gives ≈55.6 UU, while an HL ledge of 45 units becomes 90 UU
  — impassable;
- vents: HL 37 units → 74 UU against a crouched KF player's 68 UU — marginal;
- steps: `MAXSTEPHEIGHT = 35.0` (a constant in `Actor.uc`, not a property) — obstacles of 9–17 HL
  units stop being obstacles.

**The converter's default is ×1.9165, and it is the two engines' constants that pin it**, not the
player-height ratio the paragraph above computes. Two of the five conversion constraints bind:

| constraint | ratio | bound |
|---|---|---:|
| a crouched `KFHumanPawn` (2 × `CrouchHeight` 34 = 68 UU) through the smallest legal HL duck gap (36) | 68/36 | ≥ **1.8889** |
| the tallest step an HL mapper may build (`STEPSIZE` 18) under `MAXSTEPHEIGHT` 35 | 35/18 | ≤ **1.9444** |
| a specimen (`KFMonster` radius 26 → 52 UU wide) through a 32-unit HL passage | 52/32 | ≥ 1.6250 |
| a standing `KFHumanPawn` (40 UU wide) through the same | 40/32 | ≥ 1.2500 |
| a specimen (88 UU tall, `bCanCrouch=false`) through a 72-unit HL passage | 88/72 | ≥ 1.2222 |

The window is 2.9 % wide. Both constraints are ratios, so the value at equal relative margin from
each is their geometric mean: `sqrt(68/36 × 35/18) = 1.916465`, which is +1.46 % over the floor and
−1.46 % under the ceiling. A 36-unit duck gap arrives at 68.99 UU against the 68 it needs; an
18-unit step arrives at 34.50 UU against the 35 limit. `test/selfcheck.js` asserts both.

×1.39 — the player-height ratio — is 26 % below the floor, which puts every vent, duck gap and low
passage in the map under the crouched pawn. That is why the proportional number is the wrong tool:
of the five constraints it optimises the slackest one.

Two costs of not being ×2: the luxel grid no longer lands 1:1 (`--lightmap-scale 30.66` restores it —
the field is a float, powers of two are not required), and no HL grid value lands on UnrealEd's grid,
which only matters for hand-editing afterwards.

### 1.4 Precedent: how the 35 `KF-CS-*` maps were actually made

Taking their packages apart shows two clearly distinct schools:

**School A — automatic BSP→mesh import (28 maps).** The whole level is one `StaticMesh`, named after
the source GoldSrc map file (`gg_2House`, `aim_map_glock`, `x_hero_siege`, `csestate`, `Iceworld`…).
The BSP is collapsed to 3–30 brushes — just the zone shell and the trader room. Textures are named
`<sourcename>_material_N` and keep the original WAD texture dimensions. Verified on
`KF-CS-Iceworld`: 15 `StaticMesh` (907 KB), a BSP of only 78 surfs, 14 `Light`, 75
`StaticMeshInstance`.

**School B — hand-built in UnrealEd (7 maps).** `KF-CS-Dust`: 718 brushes, 651 KB of `Polys`, 17 KB
of meshes. `KF-CS-Office`: 559 brushes plus 1196 `StaticMeshActor` built from **stock** KF assets.
The author of Office writes "I recreated cs_office" — a remake, not a conversion.

No published GoldSrc → Unreal tool or tutorial exists. Whatever produced `<map>_material_N` is named
nowhere; the naming is characteristic of an OBJ/FBX → 3D package → ASE chain.

### 1.5 Automating KFEd — what exists and what does not work

The SDK (`killingfloor-sdk-nonsteam`) ships `KFEd.exe`, `UCC.exe` and an `Editor.dll` with T3D
exporters (`ULevelExporterT3D`, `UPolysExporterT3D`, `UStaticMeshExporterT3D`), import factories
(`ULevelFactory`, `UPolysFactory`, `UStaticMeshFactory`) and the full set of ASE parser tokens,
including `*MESH_CVERTLIST` / `*MESH_VERTCOL` — **vertex colours do import through ASE**.

`ucc rebuild` exists (`Syntax: ucc rebuild <file[s]>`) but is **tested and unusable**:

| input | output |
|---|---|
| `Entry.rom` 335,882 B | a package of **64 bytes** (empty) |
| `KF-CS-Action` 399 nodes / 2 atlases / 294 LightMaps | **6 nodes / 0 atlases / 0 LightMaps** |

It never prints `Rebuilding...` — only `Loading…/Saving…/Cleaning up…`. It reassembles the world from
the source CSG brushes, destroys everything that was built, and does not build lighting at all. It
cannot be used as a pipeline step.

UT2004 and KF have no `-EXEC=` switch. T3D import is documented only as an interactive editor
operation. **There is no fully headless map build with the stock tools.**

---

## 2. Format correspondence

| Entity | GoldSrc BSP30 | UE2.5 v128 | Transfer |
|---|---|---|---|
| vertices | `LUMP_VERTEXES` float×3 | `Model.Points` | direct, ×scale |
| planes | `dplane_t` | `FBspNode.Plane` + `Model.Vectors` | direct |
| tree | `dnode_t.children[2]`, negative = leaf | `iBack`/`iFront`, coplanars through `iPlane` | k faces of a node → 1 node + k−1 coplanars |
| face | `dface_t` + `surfedges`→`edges` | node with `NumVertices` + `Verts[iVertPool…]` | direct, walking edges by sign |
| UV | `texinfo.vecs[2][4]`, in texels | `pBase` + `vTextureU/V`, texels per unit | direct; `Origin = pBase`, axes divided by scale |
| texture | 8-bit miptex + 256-colour palette | `UTexture` P8 + `UPalette`, or DXT | P8 transfers without re-encoding |
| mask | `{name`, index 255 transparent | `PF_Masked`, index **0** transparent | permute the palette |
| sky | `sky` texture, `TEX_SPECIAL` | `PF_FakeBackdrop` + `SkyZoneInfo` + a sky cube | direct |
| lighting | RGB24, 16 units per luxel | DXT3 atlas 512×512, `LightMapScale` 32 UU | 1:1 at ×2 |
| collision | clipnodes, 3 inflated hulls | `LeafHulls` + `iCollisionBound`, the engine inflates itself | the CS hulls are not needed; build from hull 0 |
| zones / PVS | `LUMP_VISIBILITY`, leaves | `Zones[64]`, `FLeaf.VisibleZones`, `Connectivity` | leaf→zone clustering, 64 maximum |
| brush entities | submodel `*N` + `origin` | its own `Model`+`Polys` per volume / `Mover` | func_wall→geometry, func_door→`Mover` |
| static props | `cycler`/`monster_furniture` → `.mdl` v10 | `StaticMesh` | mdldec → SMD → ASE |
| sprites | `.spr` v2 | `Texture` + `SpriteEmitter` | direct |
| light entities | `light`, `light_spot`, `light_environment` | `Light`, `Spotlight`, `Sunlight` | direct, brightness by eye |

Lost irrecoverably back in the BSP (not our fault, not restorable): the original brushes, the
`CLIP`/`NULL`/`HINT` tool brushes, the exact position of brush entities (origin is rounded to
integers), and the original subdivision of walls into faces.

---

## 3. Recommended architecture (route B)

One Node converter, six stages. Stages 1–5 are fully automatic; stage 6 is a single pass in KFEd.

**1. Read the BSP.** Lumps, faces through `surfedges`, UVs from `texinfo`, lightmaps by `lightofs`,
submodels plus entity `origin`, the WAD list from `worldspawn.wad`. Already written and validated
(see §1.1).

**2. Textures.** Embedded miptex plus external WAD3. Special prefixes: `sky` — cut the faces and
replace with a sky cube; `{` — permute the palette so the transparent index becomes 0, set `bMasked`;
`+0` — take frame 0; `~` — flag for stage 5. Written into a `.utx` (P8 + `UPalette`, no re-encoding)
or into the ASE as BMP references.

**3. Geometry plus tessellation for light.** Faces are grouped by texture and each is cut along the
16-unit luxel grid. Every vertex gets a colour sampled bilinearly from the GoldSrc lightmap. That is
on the order of 186k vertices for de_dust, so it is split into chunks of 65k (the 16-bit index limit
of `IndexStream1`).

**4. Export ASE.** One `*GEOMOBJECT` per chunk, `*MATERIAL_LIST` with submaterials, `*MESH_MTLID` per
triangle, `*MESH_TVERTLIST` for the diffuse UVs, `*MESH_CVERTLIST`/`*MESH_VERTCOL` for the baked
light.

**5. Map skeleton in `.t3d`.** The world shell (one subtracted cube) plus a sky cube plus
`SkyZoneInfo` plus `ZoneInfo` plus `PlayerStart` from `info_player_*` plus `Light`/`Spotlight`/
`Sunlight` from the light entities (for the dynamic side: flashlight, muzzle flashes) plus `Mover`
from `func_door`.

**6. Assembly in KFEd (manual, ~10 minutes).** Import the ASE into a `.usx` → import the `.t3d` →
place the meshes → `Build Geometry` → `Build Paths` → save the `.rom`.

### What to check before starting (B's one unconfirmed premise)

Whether UE2.5 lights a mesh from `UStaticMesh.ColorStream` or only from
`UStaticMeshInstance.ColorStream`, which the editor builds. If it is the latter, the colours from the
ASE get overwritten by `Build Lighting`, and stage 3 has to be replaced by generating a
`StaticMeshInstance` (the structure is simple: `TArray<FStaticMeshLightInfo> Lights` +
`FRawColorStream`) — or you simply accept light from the placed `Light` actors.

**A 20-minute check:** build a cube with ASE vertex colours in KFEd, build lighting, dump the `.rom`,
and compare the mesh's `ColorStream` against the `StaticMeshInstance` with my parser.

---

## 4. Route C — writing the `.rom` directly

Now buildable, because the whole format is known. What has to be written:

1. **A UE2.5 package serializer** — name/import/export tables, compact index, GUID, offsets. There is
   no open-source writer for v128; the closest is `EliotVU/Unreal-Library` (MIT), which already reads
   KF packages and has half of the header write. The reader side already exists here — writing is
   symmetric.
2. **Tree translation** GoldSrc → `FBspNode`, deduplicating `Points`/`Vectors`, `Surfs`, `Verts`.
3. **`LeafHulls`** — a flat `TArray<INT>` of node indices, bit `0x40000000` meaning "take the plane
   inverted", `-1` ending a hull; `FBspNode.iCollisionBound` points at the start. **The riskiest
   part**: without it, volume traces do not find the primitive and players fall through the world,
   while hitscan keeps working — so the bug is not obvious at first glance.
4. **`Sections`** — render batches, `FBspVertex` of 40 bytes (position, UV, lightmap UV2, normal).
5. **`LightMaps` + atlases** — packing GoldSrc luxels into DXT3 512×512, plus the `WorldToLightMap`
   matrices and `LightMapBase/X/Y`. At ×2 no resampling is needed.
6. **`Zones`** — clustering leaves into ≤64 zones, `Connectivity`/`Visibility` from the GoldSrc PVS.
7. **Actors** — `Level` (`Actors[]` plus the reference to `Model`), `LevelInfo`, `LevelSummary`,
   `ZoneInfo`, `PlayerStart`.

The source `Brush`/`Polys` are not needed: objects flagged `NotForClient|NotForServer` are skipped
entirely by the engine (which is exactly what `kfmapguard` relies on). The exception is volumes: each
needs its own `Model` + `Polys` with gameplay flags.

Bot paths stay out of scope here too: either one `PATHS BUILD` pass in KFEd, or a `PathNode` +
`ReachSpec` generator of your own (there is enough data — both the geometry and the collision).

---

## 5. Legal frame

Valve permits moving assets between games in non-commercial mods, but states separately that
**"vanilla maps should generally not be ported verbatim"**. Tripwire requires that mods contain no
third-party protected property without written permission and that they be distributed free of
charge. Both public KF ports of CS maps that were found (`KF-Dust_1`, `KF-Assault`) have been removed
from the Steam Workshop for rule violations. Custom CS maps (`gg_iceworld`, `x_hero_siege`, `fy_*`)
belong to their authors, not to Valve — permission has to come from them.

Practical conclusion: on your own servers the risk is the same as for the 35 `KF-CS-*` maps already
running there; publishing to the Workshop is a different matter.

---

## 6. What is still unverified

- The source of static-mesh lighting (`UStaticMesh.ColorStream` versus
  `UStaticMeshInstance.ColorStream`) — it gates the choice inside route B and takes 20 minutes to
  settle.
- The exact behaviour of `FLightMap.WorldToLightMap` / `LightMapBase/X/Y` — the fields are read and
  the sizes add up on 362 maps, but the semantics (how the lightmap UV is actually built) are not
  decoded.
- The `FStaticLightMapTexture.Format` field: DXT3 measured on every map checked, but the
  `UseCompressedLightmaps` config allows RGBA8 too, so a writer should support both.
- UnrealEd's limit on brushes over 500 faces (known from the `bsp2t3d` documentation) was not tested
  against KFEd — it only matters for route A.
- Whether `#exec MAP IMPORT FILE=` works under `ucc make` — the one untested chance to remove the
  manual step from route B. `ucc make` silently ignores unknown `#exec`, so this has to be checked by
  whether the file appears, not by the exit code.

---

## Appendix: tools for repeating the measurements

`scripts/`, each on bare Node with no dependencies:

| file | what it does |
|---|---|
| `bspstat.js` | BSP30 parser: lumps, faces, lightmap grid computation (self-check: computed against lump size), entities, special textures, world bbox |
| `umodel-trailer.js` | full `UModel` v128 parser including the trailer; the oracle is an exact hit on `serialSize` |
| `romstat.js` | `.rom` inventory: export classes, world `Model`, static meshes, textures, actors |
| `meshbbox.js` | level mesh extents × `DrawScale` — how the port's scale was measured |
| `smallest.js` | ranking maps by trailer size — how `Entry.rom` was found for manual dissection |
| `probe.js`, `entry.js` | byte-level probes of the trailer (used while cracking the format) |
| `strings.js` | ASCII strings out of `Editor.dll`/`Engine.dll` — how the commandlets and ASE tokens were found |

The package reader they use is `kfrom.js` from
[killingfloor-map-viewer](https://github.com/TheBestPlan/killingfloor-map-viewer). Clone it next to
this repository, or point `KF_ROM_JS` at its `kfrom.js`.

```bash
cd scripts
node bspstat.js       <Half-Life>/cstrike/maps/de_dust.bsp
node umodel-trailer.js <KillingFloor>/Maps      # folder or file
node romstat.js       <map.rom>
node meshbbox.js      <map.rom>
```
