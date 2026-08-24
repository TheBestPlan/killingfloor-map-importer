# Savage: The Battle for Newerth (.s2z)

A Savage map is a `.s2z` archive (a plain ZIP) in `game\world\`. This route carries its **terrain** —
a 128×128 float heightfield (`.hm`) — as a Killing Floor landscape.

```bash
node src/cli.js --game savage "…/Savage/game/world/2towers.s2z" --out "…/KillingFloor/Maps" --verify
```

## How it works

`src/savage/s2z.js` reads the ZIP central directory and inflates each entry. The world's `.hm` is
`{ u32 width, u32 height, float32[width*height] }` with heights in ~0..1; `src/savage/convert.js`
turns it into a triangulated grid (each cell two triangles), scaled to KF units, and hands it to the
glTF route's builder — auto-coloured, spawn dropped on the surface, `--verify`ed. It is Z-up, so no
mirror is needed.

## What is missing (yet)

- **Objects** — `.objpos` places S2 `.model` files (towers, buildings, props); that model format is not
  parsed yet, so the map is its landscape only.
- **Terrain textures** — the `.cm` colour map and `.sm`/`.am` splat maps are not applied; the terrain is
  auto-coloured as ground. The heightfield UVs are generated for when they are.
