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

The world model's brush faces are read from the `FACES` / `EDGES` / `SURFEDGES` / `VERTEXES` lumps,
their UVs from `TEXINFO` (the `textureVecs` projection ÷ the texture size), and their material names
from `TEXDATA` + the texture-string table. It reuses the whole 3D-model route below it — the same KF
skeleton, sky, light and `--verify` path — so it takes the same `--scale`, `--crop`, `--ambient`,
`--glow`, `--tex-gain`, `--no-sky` options (see [`model.md`](./model.md)). Source is Z-up like
GoldSrc, so the scale defaults to the GoldSrc pawn-fit `1.9165`.

Tool surfaces (sky, `nodraw`, `skip`, `hint`, `trigger`) are dropped, as on the GoldSrc route.

## What is missing (yet)

- **Textures.** Materials come out as flat colours hashed from their name. The real look needs the
  VTF/VMT pipeline (decode the `.vtf` referenced by each `.vmt`, from the map's `PAKFILE` lump or the
  game's VPKs) — next on this route.
- **Displacements.** `dispinfo` surfaces (terrain-like ground on many maps, e.g. de_dust2's floor)
  are skipped for now — the count is logged.
- **Static props.** `prop_static` placements reference external `.mdl` models (trees, crates, most of
  a map's detail); not read yet, so the output is the brush shell.
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
