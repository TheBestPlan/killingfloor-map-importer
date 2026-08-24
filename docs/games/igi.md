# Project IGI

A Project IGI level's geometry is a set of `.mef` meshes packed in an ILFF `.res` archive at
`missions/<location>/<level>/models/<level>.res`. Point the route at that `.res` (or a level / game
folder to search for one).

```bash
node src/cli.js --game igi ".../missions/location0/level2/models/level2.res" --out ".../KillingFloor/Maps" --verify
```

## How it works

- `src/igi/ilff.js` reads the ILFF container: a `.res` is an `IRES` pack of `NAME` (a
  `LOCAL:models/x.mef` path) + `BODY` (the mesh bytes) chunk pairs; each `BODY` is itself an ILFF whose
  form is `OCEM` — a `.mef`. Chunk names are stored **reversed** (`XTRV`=VRTX, `HSEM`=MESH, `DNER`=REND).
- `src/igi/mef.js` reads each `.mef`: `HSEM` (header — model type, render face/vertex counts), `XTRV`
  (vertices, stride = size ÷ vertex count, **position float3 already in world space**), and `DNER`
  (render groups). IGI 1 stores the **index buffer inline per group** (a header carrying `indexCount`
  `uint16` @12, `vertexStart` and `vertexCount`, then that many `uint16` triangle-list indices, local to
  `vertexStart`) — where IGI 2 uses a separate `ECAF` chunk. The header size and `vertexStart` offset
  depend on the `HSEM` model type: **type 3 → 32-byte header, `vertexStart` @20; types 0/1 → 28-byte
  header, `vertexStart` @18** (the type-3 layout has 4 bytes of extra padding). This was brute-forced
  against every mesh in `level2.res` by the two invariants that must hold: the per-group index counts sum
  to `HSEM.renderFaceCount × 3`, and the walk consumes the whole `DNER` chunk exactly — type 0/1 now
  decode 52/52 models to their exact face counts (a fixed 32-byte header had misaligned every group after
  the first, producing the map-spanning garbage triangles).
- `src/igi/convert.js` reads every mesh, auto-fits the (tens-of-thousands-of-units) level to a walkable
  KF extent, and hands the world triangles to the glTF route — auto-coloured, spawn dropped on the
  geometry, `--verify`ed.

Format facts came from the `artiom-rotari/igipy` IGI2 `.mef` documentation (via the GitHub API) plus
byte-level analysis of the IGI 1 files here.

## What is missing (yet)

- **Terrain** — a flat ground quad is laid at the typical building base (25th-percentile of the mesh base
  heights) over the footprint, so the player has ground under foot (`--no-ground` to skip). The real
  outdoor terrain is an octree heightfield in `terrain/terrain.ctr` (a flat array of 32-byte `ctr_item_s`
  octree nodes, root = index 1) + `terrain/terrain.cmd` (per-node cube meshes: an 8-byte `cmd_item_s`
  header then packed `u32` triangle indices and bit-packed `u32` vertices). That decode is worked out (see
  the CTR/CMD notes) and produces a coherent, near-flat surface, but it lives in a **separate global
  coordinate frame** from the world-space `.mef` geometry (octree X/Y span ±2³⁰; meshes span ±10⁵) and the
  level→world transform is not decoded, so it cannot yet be aligned to the buildings; a uniform-LOD sample
  is also ~12M triangles (the engine draws it with view-dependent LOD). Since the terrain is near-flat
  (height varies ~0.4% across the footprint), the flat quad is a faithful stand-in.
- **Textures** — the level `.mtp`/`.tex` textures and the `DNER` group→material mapping are not applied;
  the shell is auto-coloured by geometry. The `.mef` carries no texture filenames (they live in the
  level material table).
- **Object placement is baked** — IGI already stores each mesh's vertices in world space, so no separate
  placement list is needed; skeletal (type-1) and morph data are ignored (static geometry only).
