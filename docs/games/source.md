# Source engine BSP (CS:Source / CS:GO, Half-Life 2, Garry's Mod, Left 4 Dead 1 & 2)

One VBSP reader for every Source 1 map. The input is a loose `.bsp` file.

```bash
node src/cli.js --game source "…/cstrike/maps/cs_italy.bsp" --out "…/KillingFloor/Maps" --verify
node src/cli.js --game gmod   "gm_macmillanestates.bsp"     --out "…/KillingFloor/Maps" --verify
node src/cli.js --game l4d2   "c1m1_hotel.bsp"              --out "…/KillingFloor/Maps" --verify
```

`--game` accepts `source`, `css`, `csgo`, `gmod`, `l4d`, `l4d2`, `hl2` (all the same reader). A Garry's
Mod addon ships as a `.gma` and a Left 4 Dead map inside the game's `.vpk` — unpack those first
(`gmad extract` / a VPK tool) and point this at the `.bsp`.

Left 4 Dead 2 / CS:GO maps often store individual lumps **LZMA-compressed** (`bspzip`); the reader
detects the `LZMA` lump header and decompresses transparently (`src/source/lzma.js`, verified end to
end by re-compressing a real lump — `test/lzma.test.js`).

Verified against Counter-Strike: Source (VBSP v19 and v20) — `cs_italy`, `cs_assault`, `de_dust2`,
`de_nuke`, `cs_office` all convert and pass every `.rom` invariant (`test/source.test.js`). CS:GO and
L4D2 are v21 of the same format.

## How it works

Every brush model's faces are read from the `FACES` / `EDGES` / `SURFEDGES` / `VERTEXES` lumps —
world model 0 **and** the brush entities after it (doors, windows, breakables, `func_brush`
decoration), so a doorway or window frame is no longer a hole. UVs come from `TEXINFO` (the
`textureVecs` projection ÷ the texture size) and material names from `TEXDATA` + the texture-string
table. It reuses the whole 3D-model route below it — the same KF skeleton, sky, light and `--verify`
path — so it takes the same `--scale`, `--crop`, `--ambient`, `--glow`, `--tex-gain`, `--no-sky`
options (see [`model.md`](./model.md)). Source is Z-up like GoldSrc, so the scale defaults to the
GoldSrc pawn-fit `1.9165`.

Tool surfaces (sky, `nodraw`, `skip`, `hint`, `trigger`) are dropped by their `texinfo` flags, so the
brush entities bring only visible geometry — triggers and clips on them are filtered out too.

Source maps carry no KF lights, so this route leans on the zone ambient + per-actor glow; with the
engine's ~2.5x unlit overbright that reads as a white-out, so the route lowers `texGain` (0.45),
`ambient` (40) and `glow` (20) for it. `KF_TEX_GAIN` / `KF_AMBIENT` / `KF_GLOW` override.

## What it carries

- **World + entity brushes** — faces, UVs, materials from every brush model (above).
- **Textures** — the `.vtf` each `.vmt` references, decoded (DXT1/3/5 + plain BGR/BGRA, alpha carried)
  from the map's `PAKFILE` lump or the game's VPKs (`src/source/{vtf,vmt,vpk,zip}.js`).
- **Cut-out foliage & glass** — a material with `$alphatest` / `$translucent` becomes an `STY_Masked`
  texture the engine thresholds to a hard edge (grass blades, leaves, chain-link), `bTwoSided` when the
  material is `$nocull`. Without this the grass came out as solid green rectangles.
- **Displacements** — `dispinfo` surfaces (terrain ground, e.g. de_dust2's floor): each base quad
  becomes a `(2^power+1)` grid displaced by its `DISP_VERTS`.
- **Static props** — `prop_static` placements are read from the `GAME_LUMP` `sprp`, their `.mdl`/`.vvd`
  /`.vtx` models loaded (`src/source/mdl.js`) and **instanced**: one shared `StaticMesh` per model, one
  `StaticMeshActor` per placement. The prop's Source rotation is re-expressed as a KF rotator through
  the Y-mirror (forward/up axes + `up × forward`), consistent with the player-start `-yaw`. A prop the
  map marked `SOLID_NONE` (grass, small foliage) is placed **without collision** so the player walks
  through it. A Garry's Mod DBD realm is almost entirely props; extract its `.gma` with `gmad` first. A
  model over the 16-bit index limit is split into parts; `KF_PROP_LOD` (default 2) picks a lower LOD.
- **Player starts** — from the entity lump (`info_player_*`, `info_survivor_position`).

## What is missing (yet)

- A prop's collision is the render mesh's own kDOP, not its Source VPHYSICS hull, so a highly detailed
  solid mesh (a railed staircase) collides bump-for-bump rather than as the smooth hull Source uses.
- A model over ~65000 *vertices* (none of the tested maps hit this) is still skipped.
- Displacement edge-neighbour stitching is not done (small seams possible between adjacent displacements).
- Prop LODs with per-LOD vertex fixups stay on LOD0.
## CS2 (Source 2)

CS2 is **not** VBSP — it is Source 2: the compiled world lives in a `.vpk` (v2) as `.vwrld_c` /
`.vmesh_c` (KV3 + meshopt-compressed vertex/index buffers), a different and much larger format. It is
not parsed natively here (no local sample to build and verify against, and the format is an order of
magnitude more code than VBSP). The working path is the same as for any UE4/UE5 or Blender source:

```
Source2Viewer / ValveResourceFormat  ->  export the map to glTF  ->  node src/cli.js --game model <map>.glb --verify
```

`--game cs2 <map>.vpk` prints exactly these steps; `--game cs2 <map>.glb` (already decompiled) falls
through to the [model route](./model.md). Native `.vpk` reading can be added when a Source 2 sample is
available to verify against.
