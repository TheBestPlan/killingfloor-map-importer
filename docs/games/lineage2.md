# Lineage 2 (Interlude / C6)

What a Lineage 2 client is made of, and what reading one costs. Every entry was measured against the
files in `D:\games\L2 Interlude CUZUS` or seen in the converted map running in Killing Floor.

The engine these end up in has its own notes in [`../GOTCHAS.md`](../GOTCHAS.md); the other source
game is in [`goldsrc.md`](goldsrc.md).

**Lineage 2 is the easy one.** It runs the same engine five package versions back, so this front end
is a reader rather than a rewrite: the geometry, the UVs and the pixels are the client's own and go
across untouched. Almost everything below is about the five versions of drift, not about the format.

---

## L2.1 The encryption is one XOR

A client file starts with 28 bytes of UTF-16LE naming the scheme — `Lineage2Ver111` — and the rest
is an ordinary Unreal package. Version 111's key is the constant `0xAC`, which falls out of the
first four bytes:

```
6d 2f 86 32  ^ AC  ->  c1 83 2a 9e   = 0x9E2A83C1, the Unreal package tag
d7 ac        ^ AC  ->  7b 00         = file version 123
b5 ac        ^ AC  ->  19 00         = licensee version 25
```

120 and 121 XOR with a key built from the file's own name instead. 411–414 are Blowfish and are not
handled — no Interlude map file uses them.

No external tool is needed. L2Encdec and Mxencdec were checked against this and agree on the version
list; the ten lines in `lineage2/package.js` replace them.

## L2.2 The package tables did not move between 123 and 128

Header, name table, import table, export table: our own `unreal/read.js` parses an Interlude `.unr`
with no version branch at all. 856 packages of a live client index without a single failure.

The **licensee version varies file to file** — 12, 25 and 28 all appear, sometimes between two maps
of the same client — and nothing in the format depends on it. Do not key behaviour off it.

## L2.3 A UStaticMesh is byte for byte the Killing Floor one, until the collision

Walked by hand against `water.usx` and then across a town's worth of packages:

```
property block | FBox | FSphere | Sections | FBox | VertexStream | ColorStream | AlphaStream
| UVStreams | IndexStream1 | IndexStream2   <- identical to 128/29 up to here
| collision                                 <- and different from here
```

Interlude keeps `FStaticMeshCollisionTriangle` there — the face plane plus three edge planes, 68
bytes each — where Killing Floor keeps a kDOP tree. **The tail is never read.** The converter builds
its own kDOP from the triangles anyway (it has to; see `GOTCHAS 4.7`), so the reader stops after the
wireframe stream and the difference costs nothing.

Measured: 47 of 47 meshes a town square references, and 28 more across five other packages, read
with zero failures.

## L2.4 UPolys writes PanU/PanV as INTs, not WORDs

The brush polygon object is otherwise the one this tool already emits. The difference was found by
counting rather than by guessing: a six-poly object measures **114 bytes per poly** against the 110
that the WORD reading accounts for, and the four are these.

Get it wrong and the first poly reads correctly, the second is garbage.

## L2.5 A brush names its Polys in the model's BODY, not in a property

A `Brush` actor points at a `Model`, and that model is 72 bytes with an **empty property block**. The
`Polys` reference is inside it:

```
props(1) | FBox(25) | FSphere(16) | five empty arrays(5) | INT NumSharedSides | INT NumZones | cidx Polys
```

Walked out of a real 72-byte model rather than assumed. All five geometry arrays are empty on a
brush — that is what makes it a brush and not compiled geometry.

## L2.6 The compiled world BSP is NOT readable with the 128 layout

`FBspNode`'s field list moved between 123 and 128 and a brute force over the plausible shapes — the
number of compact indices, whether the exclusive sphere is there, what the tail holds — found nothing
self-consistent: the best candidate still left 1836 indices pointing outside their arrays and 43
surfaces whose material is not an object.

It does not matter. **Read the brushes' own polygons instead** (L2.4, L2.5). They are the source the
compiler ran on, they carry their own texture mapping, and they are a format this tool already knows.
Subtractive brushes are skipped rather than carved: CSG is a subsystem of its own, and an
additive-only town is a town with its floor.

## L2.7 The terrain is a G16 heightfield, and the formula is the engine's

`TerrainInfo` carries `TerrainMap` (a G16 texture, one texel per vertex), `TerrainScale`, and the
square's world corner in `Location`:

```
z = (texel - 32768) / 256 * TerrainScale.Z + Location.Z
```

Every Interlude square measured so far is 256×256 at `TerrainScale = (128, 128, 76)`, which makes a
square 32640 units across — inside `HALF_WORLD_MAX`, so it converts 1:1 with no rescaling.

**The formula is confirmed by the file itself.** A `TerrainSector` stores its own bounding box, and
for 16_12 that box reads `Z = -4687.7` against the -4688 the formula gives.

## L2.8 A square's town can sit BELOW its own terrain

16_12's heightfield is flat at -4688 and its 1907 mesh actors are at -6823…-6414, with 56 of its 57
player starts down there with them. It is not a bug in the height formula (L2.7) and not a hole in
the terrain (L2.9): what is under the ground is a dungeon built out of brushes, and the client walks
the player on those.

Consequence for the converter: **a spawn is only usable if it stands on something that was actually
built.** Dropping the player on a Lineage 2 start without checking put him under the world, falling
until KillZ. The rule is: take the brush floor under the spawn if there is one, else the terrain if
the spawn is above it, else fall back to the highest ground in the middle of the square.

## L2.9 `QuadVisibilityBitmap` is 8192 bytes behind a 2-byte header

One bit per quad, LSB first, row-major. A clear bit is a hole in the ground — a cave mouth, the
inside of a basin.

Measured on three squares: **all 65536 bits set on every one of them.** The terrain is drawn whole;
holes are rarer than the field suggests.

## L2.10 The layer blend is in the layers' AlphaMaps, not in TIntMap

`TerrainInfo.TIntMap` looks like the blend — 528 536 bytes, `NumIntMap = 8`, almost exactly 8 bytes
per texel of a 256×256 grid — and it is not. Walked three ways; nothing in it reads as a spatial map.

The real data is `Layers[i].AlphaMap`, an ordinary texture per layer: DXT1 1024×1024 for the big
ones, P8 512×512 and DXT5 for others. Decode it and the paint map is obvious — layer 1 in the middle
of Dion's fields, 2 and 5 around the edges, the base at the borders.

A static mesh has one material per section, so the ground takes the layer that **wins** each quad
rather than blending: hard edges where the original fades, and every layer's own tiling kept. The
alternative — baking one texture for the whole square — gives 4×4 texels per quad at 1024², which is
mud.

## L2.11 Half of what a surface points at is not a texture

`ColorModifier`, `TexPanner`, `TexRotator`, `Shader`, `Combiner`: the sky's materials are three nodes
deep, and doors are `Shader`s with a Diffuse and an Opacity. Resolving a material by looking for a
`Texture` export of that name finds nothing.

Follow the graph one property at a time — `ColorModifier.Material`, `Shader.Diffuse`,
`Combiner.Material1` — down to the texture that does the painting. What is lost is the tint and the
panning; what is gained is every surface having a picture. Before this, 3205 of a square's mesh
actors resolved to nothing.

## L2.12 A non-square texture's mip chain stops when the SHORT side reaches 1

A 128×512 DXT1 ends at 1×4, eight levels, where Killing Floor wants ten — and Killing Floor derives
the count from `USize`/`VSize` rather than from the array, so it indexes past the end
(`GOTCHAS 5.33`). 33 of a town's 70 textures are like this.

Below 4×4 every level is the same single block, so the missing tail is the last level repeated at the
declared sizes. Where even that does not fit — a texture shipped with **one** mip, which happens —
the top level is decoded and re-encoded through the ordinary writer, which builds the whole chain.
G16 counts here: a terrain layer in 23_18 paints with the square's own heightmap.

## L2.13 There is no skybox to carry across

Lineage 2 builds its sky at run time: it turns with the hour and differs by region. The file says as
much — **every `SkyZoneInfo` in the client is the same object**, nine lens flares with their offsets
and scales, two pan speeds, and not one texture. `NSun` (radius 350), `NMoon` (radius 245) and
`NMovableSunLight` are what the client animates around it.

Putting one of the client's cloud textures on a cube was tried and it is worse than nothing: a
1024×512 painting stretched over six faces reads as slabs of cloud hanging in grey air with the
cube's corners showing through.

What a square *does* have is `ZoneInfo.DistanceFogColor` — the colour it fogs its own distance with,
which is the colour everything far away goes to. That is the sky: flat, in that colour, by majority
over the square's zones (20_21 has 42 of them). 92 of 153 squares declare none and get the standard
blue.

Separately, a square's own haze ring and cloud plane ARE in the file as brushes wearing `L2_Skies`
textures, twenty thousand units up. Those come across as unlit, non-colliding geometry.

## L2.14 Lineage 2's baked lighting is not in the vertex colours

`StaticMeshInstance` is the same class Killing Floor uses for per-actor baked light, and the colour
array is the first thing in it, so it looks like a free win. It is not:

| square | instances | with a lit vertex | mean channel |
|---|---|---|---|
| 16_12 | 1907 | 53 | 0.6 |
| 20_21 | 2763 | 29 | 0.3 |

The bake lives in the four megabytes of per-light records **after** the colour array — a different
subsystem. What is in the array is carried; the rest of the level is lit by the zone and the mesh
actors' own `AmbientGlow` (`GOTCHAS 4.11a`).

## L2.15 Brightness: 72, split 32 in the zone and 40 in the glow

The ground is a plain texture, not a texture multiplied by a lightmap, so the Counter-Strike route's
numbers do not carry over. Judged on 24_13 against 20 and 168: at 20 the mountain is a black cut-out,
at 168 the snow is white paper, 72 is the picture.

## L2.16 What a square actually holds

Two poles, both real squares:

| | 15_20 (wilderness) | 16_12 (built up) |
|---|---|---|
| TerrainInfo + sectors | 1 + 256 | 1 + 256 |
| StaticMeshActor | 0 | 1907 |
| StaticMeshInstance | 0 | 1907 |
| Model / Polys (brushes) | 9 | 418 |
| Light | 0 | 2596 |
| AmbientSoundObject | 0 | 2248 |
| PlayerStart | 1 | 57 |

Across the whole client: 153 squares, 108 with static meshes and 45 bare terrain, 168 515 mesh
actors, 8315 additive brushes, 25 133 textures.

## L2.17 Two squares cannot be converted, and that is the client's doing

`19_11` and `20_11` name a terrain map package — `T_19_11`, `T_20_11` — that this client does not
ship. Both are empty border squares: zero mesh actors, seven brushes, 256 terrain sectors with no
heightfield behind them. Failing with "terrain map package T_19_11 is not in this client" is the
right answer; there is nothing there to convert.

## L2.18 Assets live outside the map, so the client is the input

`staticmeshes/*.usx` is 1.1 GB and `textures/*.utx` 1.3 GB, and a square references them by package
name. Every square also has its own `T_<square>.utx` holding at least the heightmap. This is why the
converter takes a client folder rather than a file: a `.unr` on its own is a list of names.

Packages are held open once indexed — a town square comes back to the same few `.usx` hundreds of
times and each one costs a decrypt of the whole file.
