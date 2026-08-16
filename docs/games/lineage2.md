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
built**, and its own height is worth more than any surface found beneath it. Dropping the player on a
Lineage 2 start without checking put him under the world, falling until KillZ; then setting him down
on the first brush floor below put him 212 units under 17_20's town, looking up at the underside of
it, because in a town the floor is a static mesh and the brush under it is the ground it stands on.

The starts sort into three piles and the biggest one wins:

- **on the heightfield** (17_22: 8) — kept where they are, raised only if they are below it;
- **a level below it** (16_12: 12, more than 1024 units down, with a brush floor) — a dungeon, and
  the only thing that makes that square playable;
- **buried just under it** (17_20: 66, 416 units down with the town on top) — junk heights that name
  a real place, so the spot is kept and the ground above is put back under the player.

Whichever pile is largest is where the square is played. 16_12 has one stray start up on the empty
heightfield and twelve down in the dungeon that is the whole map; preferring ground level for its own
sake spawned the player on bare hillside. Nothing at all in any pile falls back to the highest dry
ground in the square.

A start over water is not automatically drowned: 17_22's harbour town stands 74 units above its own
sea on static meshes. Only one AT the surface with the seabed under it is rejected.

## L2.9 `QuadVisibilityBitmap` is 8192 bytes behind a 2-byte header

One bit per quad, LSB first, row-major — and the row stride is the map WIDTH (256), not the number
of quads across it (255). 8194 bytes is the array's 2-byte header and exactly 256×256 bits. Walking
it 255 to the row shears the mask one bit further left on every row down. A clear bit is a hole in
the ground — a cave mouth, the inside of a basin.

Holes are rare: 16_12 and 16_24 have none at all, 17_20 has 36, 17_22 has 2390. The terrain is
drawn whole almost everywhere, which is why a structure below it is invisible from above rather than
reachable — and why L2's own starts down there are editor leftovers, not spawn points (L2.8).

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

## L2.11a The client says how a surface is blended, and it is worth more than the pixels

A surface's blending is a property of the material graph — `Shader.OutputBlending`, or
`FinalBlend.FrameBufferBlending` — and Killing Floor's `EOutputBlending` is the same enum in the same
order (`Engine/Classes/Shader.uc`: Normal, Masked, Modulate, Translucent, Invisible, Brighten,
Darken). Carry the byte across and the surface looks like it does in Lineage 2. `EFrameBufferBlending`
is a different order and maps onto it: Overwrite→Normal, Modulate→Modulate, both AlphaBlend kinds and
Translucent→Translucent, Darken→Darken, Brighten→Brighten, Invisible→Invisible.

Skipping it is expensive. A torch flame is `FX_E_S.Default_Flame01`, two sections: the flame is a
DXT1 with **no alpha at all**, drawn with `OB_Brighten` so its black background adds nothing, and the
glow beside it is `OB_Translucent`. Read as textures they have nothing to say, and every torch in
16_12 came out as a flame painted on a black slab.

Where the client says nothing, the alpha decides — see L2.11b.

## L2.11b A texture with an alpha channel is usually not transparent

Half the client's DXT3/DXT5 textures have an alpha of 255 throughout: the format was picked for the
compressor, not for transparency. Setting `bAlphaTexture` on those makes Killing Floor cut the
surface out by an alpha that says nothing, and the engine draws that as a dither pattern — the
"ripple" over 16_12's wall panels.

Read the alpha and classify it, format be damned. A DXT5 block carries two alpha endpoints and every
texel in it interpolates between them, so a hard cut-out has both at 0 or 255 whatever it looks like
inside the block; a DXT3 block carries sixteen nibbles. Three answers:

- **none** — 255 everywhere. Plain texture, no `bAlphaTexture`.
- **mask** — hard 0/255. `OB_Masked`: a window in a wall, a leaf, a rope. This is nearly all of them
  — 267 of 17_22's 275.
- **blend** — a quarter or more of the samples mid-range. `OB_Translucent`: water, the sky haze.

The test is deliberately biased toward **mask**. A gradient drawn masked has hard edges; a cut-out
drawn translucent is a wall you can see through that sorts wrongly against everything behind it.

## L2.11c A flame is sixteen textures, and `AnimNext` is all it takes

`de_fire_0000` carries `AnimNext` → `de_fire_0001`, `MinFrameRate = 25`, `MaxFrameRate = 30`,
`TotalFrameNum = 16`, and the last frame points back at the first. Killing Floor's `UTexture` has
`AnimNext`, `MinFrameRate` and `MaxFrameRate` and animates them itself — carry the ring and the fire
burns, no emitter needed. Measured in game: two frames three seconds apart differ by up to 355 of 765
across the flame and are pixel-identical everywhere else.

The chain is circular, so a frame's export has to be registered before the next one is carried or the
recursion never ends; the reference is asked for at serialise time, once every frame has a ref.

What still does not come across is the particle work: 16_12 has 352 `SpriteEmitter`s and 264
`Emitter`s, and none of them is geometry.

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
