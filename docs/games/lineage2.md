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

## L2.4 The four bytes after a poly's iBrushPoly are `ShadowMapScale`, and there is no PanU/PanV

The brush polygon object is otherwise the one this tool already emits, but its tail is not Killing
Floor's. A six-poly object measures **114 bytes per poly** against the 110 that Killing Floor's
`WORD PanU, WORD PanV` accounts for, and the extra four were first read as "the pan, widened to
INTs". They are not. `FPoly` here has no pan at all - the offset lives in `Base` - and the eight
bytes after `iBrushPoly` are `FLOAT ShadowMapScale` and a sentinel word:

| square | first word | as a float | second word |
|---|---|---|---|
| 19_21 | 1107296256 / 1132462080 / 1115684864 | **32 / 256 / 64** | always -1 |
| 16_12 | 1132462080 / 1107296256 | **256 / 32** | always -1 |
| 17_22 | 1107296256 / 1132462080 / 1124073472 | **32 / 256 / 128** | always -1 |

Three squares, 2545 polygons, four distinct values between them - a per-poly texture offset does not
look like that; a lightmap resolution does.

Added to a texture coordinate the damage is total: 0x42000000 read as an integer is 1 107 296 256
texels, and at that magnitude a 32-bit float has no bits left for the polygon's own extent. Every
brush surface in every town collapsed into smeared horizontal streaks - the "distorted, overlaid"
floors and walls, which read as a texture bug and were a parsing bug.

The stride is unaffected either way, which is why it never crashed: the bytes are consumed, only
their meaning was wrong.

## L2.5 A brush names its Polys in the model's BODY, not in a property

A `Brush` actor points at a `Model`, and that model is 72 bytes with an **empty property block**. The
`Polys` reference is inside it:

```
props(1) | FBox(25) | FSphere(16) | five empty arrays(5) | INT NumSharedSides | INT NumZones | cidx Polys
```

Walked out of a real 72-byte model rather than assumed. All five geometry arrays are empty on a
brush — that is what makes it a brush and not compiled geometry.

Subtractive brushes are not drawn (CSG is a subsystem of its own), but they are read: the volume a
building was hollowed out with is the only way to tell a hall from a rock. See L2.25.

## L2.6 The compiled world BSP is NOT readable with the 128 layout

`FBspNode`'s field list moved between 123 and 128 and a brute force over the plausible shapes — the
number of compact indices, whether the exclusive sphere is there, what the tail holds — found nothing
self-consistent: the best candidate still left 1836 indices pointing outside their arrays and 43
surfaces whose material is not an object.

It does not matter. **Read the brushes' own polygons instead** (L2.4, L2.5). They are the source the
compiler ran on, they carry their own texture mapping, and they are a format this tool already knows.
Subtractive brushes are skipped rather than carved: CSG is a subsystem of its own, and an
additive-only town is a town with its floor.

## L2.6a `TerrainInfo.Location` is the MIDDLE of the heightfield

Not its corner. A vertex is at

```
Location + (ix - USize/2) * TerrainScale.X,  Location + (iy - VSize/2) * TerrainScale.Y
```

Read as a corner, every square's ground is half a square - 16384 units at 256x128 - out of place in
BOTH axes. What that looks like: the terrain cuts through the town at the wrong height, buildings
stand with their feet buried and their roofs poking out of a hillside, and half the square's mesh
actors fall outside the grid entirely (19_21: 808 of 1548). Worse, it is silent - the ground still
looks like ground, so every question of the form "what is under this spawn" gets a confident answer
about a place sixteen thousand units away.

The client names the square in `MapX`/`MapY`, and the world grid is `(MapX-20, MapY-18) * 32768`.
Measured on four squares, centred lands on that square exactly and every one of the square's own
PlayerStarts falls inside it; read as a corner, all four are off by +16384 in x and y:

| square | grid square | as a corner | centred |
|---|---|---|---|
| 19_21 | x -32768..0 | -16384..16256 | **-32768..-128** |
| 16_12 | x -131072..-98304 | -114688..-82048 | **-131072..-98432** |
| 17_20 | x -98304..-65536 | -81920..-49280 | **-98304..-65664** |
| 23_18 | x 98304..131072 | 114688..147328 | **98304..130944** |

`test/selfcheck.js` checks this against the client when there is one.

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

16_12's heightfield is flat at -4688 over the whole town and its 1907 mesh actors are at
-6823…-6414, with 56 of its 57 player starts down there with them - a median of 2010 units under the
ground. (Measured with the terrain in the right place; see L2.6a, which moved every earlier ground
reading by half a square.) 17_20 is the same shape: its starts sit a median of 2244 below. It is not a bug in the height formula (L2.7) and not a hole in
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
- **buried just under it** — junk heights that name a real place, so the spot is kept and the ground
  above is put back under the player. (17_20 read this way while the terrain was half a square out
  of place; with L2.6a fixed its starts are a real level below, not buried.)

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

A static mesh has one material per section, so the first version took the layer that **won** each
quad: hard edges where the original fades, and every layer's own tiling kept. Baking one texture for
the whole square was the other option and is worse — 4×4 texels per quad at 1024², which is mud.

**Superseded by L2.27**, which blends after all: a pass per layer, weighted by the mesh's own vertex
alpha. The dominant-layer map is still what picks the base.

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

Where the client says nothing, see L2.24 for the order the answer is looked for in.

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

**Superseded in part by L2.24.** Classifying the alpha is still how an `Opacity` node's kind is
decided, but it is no longer allowed to make a bare texture see-through on its own: the client says
what it wants, and a wall with a soft-alpha window pane is a wall.

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

## L2.19 The particle systems come across as settings, not as geometry

An `Emitter` is an ordinary actor holding an `Emitters` array of `SpriteEmitter` objects, and both
engines call the fields the same things. Of the 43 property names the client's emitters actually use,
**39 are declared on Killing Floor's own `ParticleEmitter`** — `ColorScale`, `StartSizeRange`,
`LifetimeRange`, `StartVelocityRange`, `SizeScale`, `FadeIn`/`FadeOut`, `DrawStyle`, `Texture`,
`MaxParticles`, `SpinsPerSecondRange`… The four that are not (`WeatherSoundCheck`,
`UseMeshBlendMode`, `RenderTwoSided`, and `StaticMesh` on `MeshEmitter`) the loader skips on its own,
because a property tag carries its own size.

So nothing here interprets the effect. The property block is read into a tree and written back out;
the other engine runs it. 16_12 has 260 emitters over 352 particle systems, 17_20 has 69 over 106.

Two things do have to be rewritten:

- **object references.** A name index means nothing outside the package it came from, so every
  `Texture` is resolved through the same material path the surfaces use — which also gets it the
  client's own `OutputBlending` (L2.11a).
- **when.** Carrying a texture registers new exports, and an export added while the package's bodies
  are already being serialised is one the export table never hears about — the writer walks a list it
  snapshotted. Resolve first, serialise second.

The tree is generic rather than a schema: a `RangeVector` is three `Range`s, each its own tagged
block, and `ColorScale` is an array of blocks. Reading blocks and writing blocks needs nothing that
has to be kept in step with two engines. The one thing the file does not say is what a dynamic
array's ELEMENTS are — the property's declared type is not stored — so the reader tries tagged blocks
first and falls back to compact object indices, and keeps whichever consumes the span exactly.

`MeshEmitter` is not carried yet (4 in 16_12, 29 in 17_20): its `StaticMesh` needs the mesh cache,
which lives inside the mesh pass. It is reported, not dropped silently.

## L2.20 A start needs something BUILT under it, not just a height that looks right

Lineage 2's own `PlayerStart`s are editor leftovers, and the checks that keep them honest have to ask
what this converter actually produced. Two more, after the piles in L2.8:

- **Over water.** 17_22's harbour town stands above its own sea and is fine, because the piers under
  it are static meshes. 16_24's single start floated over its bay with the nearest mesh actor 680
  away — the water has no collision, so the player falls through it and dies
  on the seabed. The test is whether any mesh actor stands within 400 units in XY and 1024 in Z.
- **High in the air.** Same test, for a start more than 512 units above the heightfield. Nothing
  holding it up means it is set down on the ground rather than dropped from a height.

Mesh actor ORIGINS answer this, not their triangles: the question is coarse — "on the town, or over
open sea" — and triangles would need every actor's rotation matrix rebuilt. A start hanging over a
courtyard with meshes around its edges reads as held up; triangle-accurate ground is the upgrade if
that ever bites.

## L2.21 `OB_Translucent` is ADDITIVE, so the sea takes no glow at all

Killing Floor's translucent output blending adds rather than mixes — black is transparent and
brightness is opacity. That makes a lit water surface wash out: at the world's `AmbientGlow` (40)
16_24's ocean was a black band across the bay, at `bUnlit` 17_22's harbour was white glare, and at a
half-way glow of 128 it was still 223,211,205 over a seabed of 64.

Water gets no glow of its own. The zone's ambient alone leaves the sheen the additive pass is for,
and the seabed shows through it. The sky stays `bUnlit`; that one really is drawn, not lit.

## L2.22 The level's box has to enclose the DUNGEON, not just the ground

`KillZ` comes from the floor of the world box, and the box was drawn around the heightfield. Cruma
Tower on 20_21 is brush geometry down at -12016 with the terrain 8000 units above it, so the box
floor landed at -8109 and `KillZ` at -9109 — nearly three thousand units above the only spawn the
square has. The player appeared in the dungeon and died at `Elapsed Time: 00:01`.

Size the box around everything the level will hold: the heightfield, the brush vertices, and the mesh
actors' origins. On 20_21 that moves the floor from -8109 to -20320. It costs one extra pass over
data already read, and the brushes are read once and used twice rather than twice over.

Squares where this was already fine (16_12's dungeon is only 2000 below its ground) hid the bug.

## L2.23 A particle takes a texture, not a material

`ParticleEmitter.Texture` is declared as a `Material` and a `Shader` IS one, so it loads clean and
verifies clean — and then the D3D9 renderer walks into it and dies the moment a particle is on
screen:

```
General protection fault!
History: FD3D9RenderInterface::SetParticleMaterial <- FD3D9RenderInterface::SetMaterial
      <- USpriteEmitter::RenderParticles <- AEmitter::Render <- FDynamicActor::Render
```

Resolve an emitter's texture straight to the `Texture`, not through the material path the surfaces
use. Nothing is lost: the particle system does its own blending through `DrawStyle`, which the client
sets per emitter.

A system whose texture could not be carried is dropped rather than left to the class default — the
default is an editor sprite, and a system painting with that is a grid of question marks in the air.

## L2.24 `AlphaTest` outranks the alpha channel, and a bare texture is opaque

Lineage 2's `Shader` carries two fields Killing Floor's does not: `AlphaTest` and `AlphaRef`. They
are the client saying "this alpha is a CUT-OUT", and they outrank anything the pixels look like.
Foliage and window glass are `AlphaTest=true, AlphaRef=10` over an alpha that is half mid-range;
classified from the histogram they read as gradients, were drawn `OB_Translucent`, and came out as
**glowing white trees and walls you could see through**.

The order that works, most direct statement first:

1. `Shader.OutputBlending` — a flame is `OB_Brighten`; a fence is the `_m` twin of its texture, a
   Shader whose entire content is `OutputBlending=OB_Masked` (`Gl_C_fence_m`, `GL_p_net_m`, …).
2. `AlphaTest` — a cut-out, however soft the alpha.
3. An `Opacity` node — then ITS alpha decides which kind: a gradient is water or the sky's haze ring,
   a hard 0/255 is a flag, a carpet, a dagger.
4. The texture's own `bMasked` / `bAlphaTexture` (`SSQ_netalpa02` has `bMasked=true`).
5. Otherwise **opaque**. A bare texture's alpha channel is not an instruction: `Gl_CV_wall_win03` is
   a DXT3 wall with a soft-alpha window pane and the client draws it solid.

On 19_21 that takes the non-opaque surfaces from "everything with an alpha" down to seven: two flame
materials, the indoor water, a rope the client explicitly marks translucent, the sea, and the sky's
two layers.

## L2.25 A building is a block with its rooms subtracted, so "inside a brush" is not "inside rock"

Subtractive brushes are skipped (L2.5's note), and that has a consequence for spawns: a castle is one
additive block with its halls carved out, so EVERY start in it is geometrically inside an additive
brush. 16_12's dungeon is the same shape - all 55 of its starts are inside one 11840x14592x832 box.

So the test has two halves: inside an additive hull AND inside none of the subtractive ones. The
first alone threw away every dungeon start on the map; the pair keeps them and still refuses a start
buried in a wall (19_21 had one inside a 300x1192x512 block of `GL_CA_wall02`).

A start in a carved room is kept, but ranked last. The room is really there and looks right from the
inside - what is missing is the doorway, because the doorway was carved too, so the player is sealed
in. A square with anywhere outdoors to stand uses that instead, whatever the counts: on 19_21 one
start in the street beats seven in houses.

## L2.26 The two games do not measure with the same ruler

A Lineage 2 character is about half the height of a Killing Floor pawn, so a town carried across 1:1
fits the world and not the player: the player stands as tall as a house door (Screenshot_53). The
squares go through the same `scale` knob the Counter-Strike route uses to turn Half-Life units into
Unreal ones, with a default of **2**.

One thing has to move with it. The world box reaches 24000 units above the highest ground so the sky
has somewhere to be, and the sky cube was centred on the box's middle — which is up there with it. At
scale 2 that put the cube's floor 14000 units over the player's head: he stood outside his own sky
and saw black at the horizon with the last frame smeared across it. The cube is centred on the ground
and sized to hold the whole box, corners included; at scale 2 that is a half-size of about 62000, and
the renderer draws it.

## L2.27 The layer blend fits on a static mesh after all — as vertex alpha

The client blends its terrain layers per texel through each layer's `AlphaMap`. A static mesh section
has one material and one set of UVs, so the first version took the layer that WON each quad, and a
field came out as a patchwork of hard squares (Screenshot_54/55).

What makes it work is `Engine.VertexColor`: a material that hands the mesh's own vertex colour to
whatever asks. So each layer above the base gets a pass of its own over the same ground —

```
FinalBlend { FrameBufferBlending = FB_AlphaBlend, ZWrite = false, ZTest = true
             Material = Shader { Diffuse = the layer's texture, Opacity = VertexColor } }
```

— and the mesh carries that layer's weight in the alpha of every vertex. The blend lands on the
terrain's own grid, a quarter the resolution of the alpha map and enough to turn the squares into a
gradient. `ZWrite` is off because the pass is coplanar with the base under it, and the base section
is written first so the overlays blend in the order they are laid down.

It is not free: 19_21 goes from 127 668 triangles of ground to 372 558, and the file from 62 MB to
95. A quad joins an overlay only if the layer reaches one of its corners with a weight of 8 or more,
which is what keeps that from being worse.

## L2.28 The grass is in the map, as a density map and a seed

`TerrainInfo.DecoLayers` is a list of decoration layers, and each one is a static mesh plus a grey
`DensityMap` over the whole square: 19_21 has three (`Grass009`, `Gludio_General_grass001`,
`Gludio_General_grass014`), 512×512 maps with 0.7–2.4% of their texels painted, `MaxPerQuad` 20/8/7,
and a `ScaleMultiplier` range per layer.

What is NOT in the file is where any single blade stands — the client scatters them at run time from
`Seed`. So the converter scatters its own to the same density, deterministically, and since Killing
Floor has no decoration layer the result has to be geometry. A blade is 5 to 20 triangles and a square
wants tens of thousands of them, which is hopeless as actors and ordinary as merged meshes: the
instances are baked into one static mesh per 18000 triangles, non-colliding, so a player walks through
grass rather than into it.

19_21: 31 964 plants over 15 meshes, 240 110 triangles, +41 MB. It is the heaviest single thing the
converter emits, which is why it is a checkbox (`--no-grass` on the command line).

The cap that keeps it to that has to THIN the field, not fill up and stop. A limit that stops leaves
the grass in whichever rows the scatter happened to walk first and bare ground for the rest of the
square, so the density is summed first and every quad's count multiplied by `limit / total`.


## L2.29 What seals a cave mouth, measured

25_14's Dragon Valley entrance is open in the client and walled in the conversion (Screenshot_59).
Ray-cast against everything the converter emits, through the arch at (168900, y, z) along +X:

```
z= -2400 ###########      # = something is hit,  . = open
z= -2200 ###########      y from -116700 to -115700, step 100
z= -2000 ###########
z= -1800 ###########
```

Two different things do the sealing:

- **the entrance mesh itself.** `godad_fireentrance_S.godad_fire_entrance` has eight sections, and
  section 7 `wall_ent` (181 faces, a 312x553x681 block) sits exactly in the opening, with `Wall` and
  `wall_top` around it. Nothing marks it hidden: the mesh's `Materials` entries carry only
  `bNoDynamicShadowCast`, `EnableCollisionforShadow` and `EnableCollision` (all normal), the actor has
  no `Skins`, its `StaticMeshInstance` is an empty property block over baked colours, and
  `TexModifyInfo` is `bUseModify=false`.
- **a brush behind it.** With the mesh alone the ray at y=-116300, z=-2000 passes straight through;
  with the brushes in, a `Godad_DC_field` polygon stops it at 1451.

The brush half of that is now cut (L2.29's rules below). The MESH half is left alone on purpose:
`wall_ent` is the outer shell of the rock, not a plug in front of it, and taking it out opens the sky
(L2.31). The 96-unit flood fill that made this section read "sealed" was too coarse to see the gap -
at 32 units the cave is reachable with the brush carve alone.

Re-deriving CSG from the brushes was tried and does not stand up:

| square | polys | ordered carve | ignoring order |
|---|---|---|---|
| 16_12 | 627 | 42 removed, 57/57 starts keep a floor | 609 removed, 0/57 |
| 19_21 | 970 | 195 removed, 8/8 | 952 removed, 0/8 |
| 17_22 | 948 | 39 removed, 12/12 | 930 removed, 0/12 |
| 17_20 | 1524 | **1311 removed, 22/68** | 1506 removed, 0/68 |
| 25_14 | 188 | 77 removed - and the cave stays sealed | 170 removed |

Ignoring the order collapses every square to 18 polygons, because the first brush of a level is one
huge subtract that hollows the world out of solid rock and everything else sits inside it. Keeping
the order (export order) works on three squares and destroys 17_20, where export order is evidently
not the order CSG ran in.

**What works without knowing the order at all**: ask what the cut LOOKS like.

- A volume that swallows a whole face is a room being hollowed out. This converter already draws
  those rooms - from the inside of the block they were carved from - so the face stays and the volume
  is ignored. That one rule disarms the world-hollowing subtract every level starts with.
- A volume that leaves a ring of the face behind is a doorway, a window, a tunnel mouth. That is the
  cut to keep.
- And only on a WALL. 16_12's dungeon floor is a single face far larger than the hall carved into it,
  so a hole punched through it left 2 of 57 spawns with anything to stand on. Faces whose normal is
  more vertical than horizontal are never carved.

Measured with those three rules. OFF by default - it re-derives what the client already compiled,
so a square wants a look before it ships. The panel’s "Open the doorways and cave mouths", or
`--carve` on the command line:

| square | brush polys | wall faces opened | spawns keeping a brush floor |
|---|---|---|---|
| 16_12 | 627 → 653 | 156 | 57 → 57 |
| 20_21 | 1275 → 1474 | 132 | 4 → 4 |
| 17_22 | 948 → 1206 | 77 | 12 → 12 |
| 19_21 | 970 → 1130 | 42 | 8 → 8 |
| 25_14 | 188 → 208 | 19 | 1 → 1 |
| 17_20 | 1524 → 1535 | 16 | 62 → 62 |

Not one polygon is deleted - the operation only ever adds pieces - so nothing a player stood on can
vanish.


## L2.30 A carve is a hole only if the face survives it

The rules in L2.29 opened 25_14's cave and then ate the inside of it: walls with holes onto the void,
lava showing through rock (Screenshot_65/67). Measured per face, one volume was taking **98%** of a
wall and leaving a sliver - which passed the "it left something behind, so it is a doorway" test.

The bound that fixes it is on the AREA. A volume may take at most 40% of a face; past that it is a
room being hollowed out and is ignored, sliver or no sliver. On 25_14 the real doorway costs its wall
1%. After the bound, the worst single face on any square measured loses 27-40%, and the cave still
opens:

| square | wall faces opened | worst face loses |
|---|---|---|
| 20_21 | 151 | 37% |
| 16_12 | 70 | 39% |
| 19_21 | 58 | 40% |
| 17_22 | 50 | 39% |
| 25_14 | 21 | 36% |
| 17_20 | 16 | 27% |

The bound is the idea that a doorway is small compared to what it goes through. Nothing in the file
says which volumes are doorways, so the size is what says it.


## L2.31 Clearing mesh geometry out of a passage mouth: tried, measured, reverted

The other half of L2.30 took static-mesh geometry out where a carved volume punches through a wall -
the "plug" of L2.28. It is gone. It cost real rock and bought no reachability.

**What it cost.** On 25_14 the mouth caught four sections, and taking any of them opened the sky:

| section | material | faces in the mouth | size |
|---|---|---|---|
| `godad_fire_entrance#7` | `wall_ent` | 172/181 | 312x555x681 |
| `godad_fire_entrance#6` | `godad_wall_e2` | 86/87 | 508x646x494 |
| `Godad_DC_pillar02#1` | `Godad_BBOOL` | 40/40 | 184x153x240 |
| `godad_fire_entsmall#2` | `godad_stonetree02_bark01` | 40/40 | 28x29x132 |

Built one at a time and photographed from the square's own start: with `godad_wall_e2` alone gone the
wall is whole and nothing opens; with `wall_ent` gone the arch opens AND a rectangle of sky appears
above it, because `wall_ent` is not a plug in front of the mountain - it IS the mountain's outer
shell there, and behind it is nothing. Cutting per TRIANGLE instead of per section (913 triangles)
made the rectangle bigger, not smaller: the carved volume is 775x580 and the rock it stands in is
thinner than that.

**What it bought.** Nothing. A flood fill through the free space from the start (`scratchpad/flood.js`),
counting a cell free only when no triangle touches it:

| voxel | no carve at all | brush carve only | brush carve + mesh clearing |
|---|---|---|---|
| 96 | 174508 | 174508 | 175948 |
| 48 | 174604 | **175996** | 175996 |
| 32 | 174636 | **175980** | 175980 |

The 96-unit grid is what said the cave was sealed, and it was wrong: the gap into it is about 160
units across, and a conservative 96-unit voxelisation closes a 160-unit gap. At 48 and 32 the brush
carve alone reaches the same depth as the mesh clearing did. The passage into 25_14's cave is open
without touching a single mesh triangle.
