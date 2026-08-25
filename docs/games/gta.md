# GTA III / Vice City (RenderWare)

Both games are RenderWare; one reader serves both. Point `--client` at the game's install root (the
folder that has `models\gta3.img` and `data\`).

```bash
node src/cli.js --game gta3 --client "…/Grand Theft Auto III" --out "…/KillingFloor/Maps" --verify
node src/cli.js --game vc   --client "…/Grand Theft Auto Vice City" --crop 200,-1300,350 --verify
```

`--game gta3` / `--game vc` (aliases `gta`, `vicecity`).

## How it works

A GTA map is data, not a single file: **item definitions** (`.ide`, text) map a numeric id to a model
(`.dff`) and texture dictionary (`.txd`) name; **item placement** (`.ipl`, text) lists instances of a
model at a position / scale / rotation. The models live in the game's **IMG archive** (`.dir` index +
`.img` blob, RenderWare VER1). This route:

1. reads every `.ide` and `.ipl` under `data\` (`src/gta/placement.js`) — the id→model map and the
   instance transforms;
2. opens `models\gta3.img` (`src/gta/img.js`);
3. decodes each referenced `.dff` once (`src/gta/dff.js` — a RenderWare chunk walker ported from
   aap/librw: frame list, geometry list, atomics → vertices/UVs/triangles, placed by the atomic's
   frame matrix);
4. transforms each instance's geometry by its IPL position / scale / quaternion and hands the world
   triangles to the glTF route's builder — the same KF skeleton, auto-colour, spawn-drop and `--verify`
   path.

GTA is Z-up and metre-scaled, so it feeds axes `[0,1,2]` with a Y flip; the default scale is **60.06**
(metres → KF units) — character parity, the same rule the other routes use: the GTA player ped is 1.665 m
tall and `KFHumanPawn` is 100 uu, so `100 / 1.665` stands the KF pawn in the world at a real ped's height.
`--scale <n>` overrides.

## Sizing the map: district, crop, or tiles

A whole GTA city is **millions of triangles across kilometres** (GTA III is ~2.75 M triangles over 4×3
km) — far too big for one KF level. Three ways to cut it down:

- **default** — one **district**: the densest 100 m cell (a built-up area, never open water), a 220 m
  half-extent (a 440 m square, sized so the doubled geometry stays under the triangle budget and is not
  decimated). The centre is logged so you can pick another with `--crop`.
- **`--crop cx,cy,half`** — a named square (metres, GTA world coordinates); **`--whole`** — the entire
  map (large, slow, not really viewable end to end in KF).
- **`--tile [m]`** — split the WHOLE city into `m`-metre squares (default 400) and write **one `.rom`
  per populated square**: `KF-GTA3-01`, `KF-GTA3-02`, … Each square is verified on its own.

### How the tiling avoids seam artifacts

- **Whole instances, never cut mid-mesh.** Each instance is assigned to the square its ORIGIN falls in
  and rendered complete, so a building or a lamp is never sliced down the middle.
- **Overlap margin.** Each square also pulls in the instances just past its edge (`--tile-overlap`,
  default 12 % of the square), so a lamp keeps the wall behind it and a façade keeps its base — no
  meshes floating over a seam with nothing under them.
- **Empty squares skipped.** A square with fewer than `--min-instances` origins (default 12) is open
  water / empty and is not written.
- **Dense squares are decimated, not holed.** A square over the triangle budget is thinned by
  coverage-preserving vertex clustering (`src/gltf/decimate.js`), which keeps the walls; earlier this
  clustering could collapse flat façades to zero-area triangles the mesh builder then culled, holing out
  the tile — that is fixed (a coincident-position triangle is now dropped at decimation, not emitted).
  Tile textures are capped at 256 px (`--max-texture` overrides) so the many `.rom` files stay light;
  a square still heavy after that is flagged so you can shrink `--tile`.

## Textures

The `.txd` texture dictionaries are decoded (`src/gta/txd.js`): GTA III's rasters are 8-bit palettised
(a 256-entry BGRA palette + one index per texel), Vice City's are DXT1/3/5 compressed — both handled,
plus the raw 16/32-bit layouts. Each `.dff` material names its raster; the triangle's material id maps
to it, so the world is drawn with its real textures (an untextured/unresolved face falls back to a flat
colour). Ground/road tiles are single-sided, so horizontal faces are doubled to show from above.

## What is missing (yet)

- **LOD models** — the low-detail `LOD*` stand-ins are dropped so they don't double the geometry; only
  the high-detail instances are kept.
- **Entity spawns** — a single synthetic player start is dropped onto the geometry near the middle of
  the crop; GTA has no KF-style spawns to carry.
- **Collision** (`.col`) — KF collides the render mesh itself, so the separate collision meshes are not
  used.
