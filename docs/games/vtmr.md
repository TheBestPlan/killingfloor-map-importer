# Vampire: The Masquerade — Redemption (Nihilistic "Nod" engine)

Redemption's levels live in `Levels.nob` — a **ZIP** of `levels/*.nil` files. Point the route at that
`.nob` (it converts the biggest level, or the one named by `--level`), or at a single `.nil`.

```bash
node src/cli.js --game vtmr ".../VAMPIRE_CD2/Setup/Levels.nob" --level l1_brot --out ".../KillingFloor/Maps" --verify
```

`--game vtmr` (aliases `vampire`, `redemption`).

## How it works

A `.nil` (magic `NIL\x10`, NIL **v27**) is a numeric Nod scene graph. `src/vtmr/nil.js` reads:

- **Header** — material-name count at 0x5C, then that many 0x20-byte shader names
  (`London\SBIwall1_2_L`, `New_York\SWfloor1_2_NY`, …).
- **Per-sector geometry.** The sector skeleton matches the official NodSDK `nil.htm` spec — `SectorFlags`,
  ambient, sector planes, surface planes, a collision-only BSP tree, then `NumVertices` (`u16`) +
  `aVertices[]` (`float3` LE), then `NumSectorVerts` (`u16`) + `cSectorVertex[]`. `nil.htm` is **truncated**
  right at `aSectorVertices`, so the wedge fields and the triangle order below were reverse-engineered from
  the game's own files and verified byte-for-byte.
  - `cSectorVertex[]` — 24 bytes each: `posIndex u16 @0` (**into `aVertices`**), a per-sector
    flags/base-material `u16 @2`, `RGB @4`, `alpha @7` (`== 0xFF`, the reliable record marker), `texU
    float @8`, `texV float @12`, lightmap `U/V` at `@16`/`@20`. The wedges are a **Direct3D triangle strip**
    over `aVertices`: consecutive triples are triangles, and a repeated index (a degenerate triangle)
    restarts the strip between surfaces. Rebuilding that strip reproduces the geometry exactly — every
    sector ≥95 % vertex-covered with **zero cross-surface edges** (`l1_brot` 115/115 sectors, `v1_nrth`
    56/56). An earlier parse read the same record 6 bytes out of phase (`posIndex` at +18), pairing each
    wedge's UV with the *next* wedge's position — that misalignment was the source of the holes and crooked
    textures, now fixed.
  - The reader anchors on the wedge run (`alpha == 0xFF`), asserts `NumSectorVerts (u16 just before it) ==
    run length`, then recovers `NumVertices` (`u16` just before `aVertices`) to land `aVertices` exactly.

`src/vtmr/convert.js` opens the game's **`LMaterials.nob`** (sibling of `Levels.nob`) and maps a material
name (`London\SBIwall1_2_L`) to its texture (`materials/london/sbiwall1_2_l.tga`, decoded by
`src/vtmr/tga.js`), applying it with the vertex UVs. It auto-fits the level, drops a spawn, `--verify`es.
Nod is Y-up → axes `[0,2,1]`. Both `l1_brot` and `v1_nrth` convert **100 % textured**, all `.rom`
invariants passing.

## Materials — type-matched from the sector base material

The material name encodes the surface **type** (`SBIwall` / `SBIfloor` / `SBIceiling` / `carpet` /
`sidewalk` / `snow` / `curtain` / `arch` …). Each sector carries one **base material** (the `u16 @2` in its
wedges, constant across the sector — a valid index into the header material table). The route textures every
surface by matching its own **orientation** (floor / ceiling / wall, from the triangle normal in Nod's Y-up
space) to a same-type material — the sector base first, then the level's palette for that type. A floor gets
a floor texture, a wall a wall texture — the right kind of texture in the right place.

## What is approximate (the v27 ceiling)

- **Geometry and topology are exact.** The triangle strip reproduces every sector's surfaces with full
  vertex coverage and no cross-surface webbing — the previous "gaps / crossing triangles" were the 6-byte
  wedge misalignment, not a format limit.
- **Exact per-FACE material** is not in the public spec (`nil.htm` cuts off before the render surfaces) and
  is not encoded per-wedge, so materials are type-matched from the sector base material (above) rather than
  pixel-exact per face.
- **Skeletal / dynamic objects** are not carried; this is the static sector world.
