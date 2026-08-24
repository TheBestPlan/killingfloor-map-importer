# Source 2 (Counter-Strike 2 / Dota 2)

A Source 2 map is a single `.vpk` (VPK **v2**, magic `0x55AA1234`) — not a loose file like Source 1's
BSP. Its world geometry is **baked** into embedded compiled models and read natively here.

```bash
node src/cli.js --game source2 "…/csgo/maps/de_dust2.vpk" --out "…/KillingFloor/Maps" --verify
```

`--game source2` (aliases `cs2`, `source 2`) takes the `.vpk`. Handed a Source 1 `.bsp` it points you
at `--game source`; the reverse also holds — a `.vpk` given to `--game source` routes itself here (a
first-four-bytes engine sniff, `VBSP` vs `0x55AA1234`).

## How it works

Everything is parsed from scratch — no external decompiler, no ValveResourceFormat dependency:

1. **VPK v2** (`src/source2/vpk.js`) — the directory tree of `(extension, path, name) → entry`, then the
   embedded data section (map `.vpk`s keep everything at archive index `0x7FFF`).
2. **Compiled resource** (`src/source2/resource.js`) — the small block table (`DATA`, `CTRL`, `MVTX`,
   `MIDX`, `MDAT`, `RERL`, …) inside each `.vmdl_c` / `.vwrld_c`.
3. **Binary KV3** (`src/source2/kv3.js`) — versions 2–5 (CS2 uses v5), including the v5 split
   buffer1(strings) / buffer2(values+types+object-lengths) layout, LZ4 (`src/source2/lz4.js`) or zstd
   (Node built-in) block decompression, and the recursively typed value tree. Ported field-for-field
   from ValveResourceFormat's `BinaryKV3`.
4. **meshopt** (`src/source2/meshopt.js`) — the vertex (v0/v1) and index codecs Source 2 uses for its
   `MVTX` / `MIDX` buffers, ported from ValveResourceFormat / zeux/meshoptimizer.

The world's shell is baked into aggregate/overlay meshes embedded in the map `.vpk` as `.vmdl_c`
resources: a `CTRL` block (KV3) names each mesh's vertex/index buffers, their meshopt block index, the
element count, the stride and the input layout; the `MVTX`/`MIDX` blocks hold the meshopt-compressed
buffers, **already in world space**. Reading every embedded mesh and decompressing it rebuilds the
level without walking the scene graph — verified against `de_dust2.vpk` (779k triangles, all `.rom`
invariants pass) and `de_overpass_vanity.vpk` (its total bbox matches the world node bounds exactly,
confirming the buffers are world-space).

Those triangles become the glTF route's scene shape and go through its builder — the same KF skeleton,
auto-colour, spawn-drop and `--verify` path the model and Source 1 routes use. Source 2 is Z-up and
inch-scaled like GoldSrc, so it feeds axes `[0,1,2]` with a Y flip and the same pawn-fit `1.9165` scale.

## What it carries

- **Baked world geometry** — every embedded aggregate/overlay mesh, world-space, as static meshes. A CS2
  map is ~4.3M triangles, far past what KF renders smoothly, so the whole shell (ground + walls + props;
  foliage dropped unless `--foliage`) is **decimated** to a triangle budget — coverage-preserving vertex
  clustering (`src/gltf/decimate.js`), not dropping whole meshes, so nothing holes out; only detail
  coarsens. Budget defaults to 500k (`KF_S2_MAX_TRIS`); pin the grid cell with `--cell` / `KF_S2_CELL`.
- **Textures** — each baked per-material `.vmdl_c` names one `.vmat` in its `RERL` block; that material's
  `g_tColor` `.vtex_c` is decoded from the game's shared `pak01_dir.vpk` (one directory up from the map
  `.vpk`) and applied with the mesh's TEXCOORD-0 UVs (`src/source2/vtex.js`, `src/source2/bc7.js`). DXT1,
  DXT5, BC7 and raw RGBA/BGRA are decoded, LZ4-compressed mips included; `de_dust2` comes out 100 % of its
  triangles textured. A face whose material or format can't be resolved falls back to auto-colour.
- **Auto-colour** — the fallback for any untextured face: coloured by geometry (roof / wall / ground /
  foliage), exactly as a textureless model rip is.
- **A synthetic player start** — dropped onto the geometry near the middle of the map (CS2 entity lumps
  are not parsed for spawns yet).

## What is missing (yet)

- **External prop models** — the worldnodes' scene objects place `models/props/*.vmdl_c` that live in the
  game's *other* VPKs (`pak01_dir.vpk`), with a per-instance transform. Only the map's own embedded baked
  meshes are carried; the loose props are not.
- **Entity spawns** — the `.vents_c` entity lumps (info_player_*, deathmatch spawns) are not parsed, so a
  single synthetic start stands in.
