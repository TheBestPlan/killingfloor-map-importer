# Tactical Ops: Assault on Terror

What reading an Unreal Engine 1 client costs, and what Tactical Ops' own conventions do to a
conversion. Every entry was measured against the shipped game files or seen in the running Killing
Floor client.

The engine these end up in — Killing Floor, Unreal Engine 2.5 — has its own notes in
[`../GOTCHAS.md`](../GOTCHAS.md); the other source games are in [`goldsrc.md`](goldsrc.md),
[`quake3.md`](quake3.md) and [`lineage2.md`](lineage2.md).

Counted over the shipped game: **33 `TO-*.unr` maps** in a 3.4 install, plus the three menu
backdrops (`Entry`, `Intro`, `CreditsTO`) which are not levels anyone plays.

---

## TO.1 The shortest hop this tool makes

Tactical Ops is a total conversion of Unreal Tournament 99, so its files are ordinary Unreal Engine
1 packages: tag `0x9E2A83C1`, **file version 69**, licensee 0, no encryption of any kind. Killing
Floor is version 128 of the same container. That makes this the closest pair of formats the
converter has ever been given:

| | GoldSrc / Quake 3 | Tactical Ops |
|---|---|---|
| coordinates | right-handed, Y mirrored on the way in | **the same axes** — nothing is mirrored |
| UVs | projected from texture axes / stored per vertex | **the same projection Killing Floor uses** |
| textures | miptex + WAD / tga+jpg in a zip | **`UTexture` with a `UPalette`**, one version older |
| properties | entity key-values | **the same tagged property block** |
| rotations | degrees / integers | **the same 65536-unit rotator** |

What still has to be done: the BSP becomes static meshes (the route every game here takes, and the
one KFEd can rebuild), and UE1's baked light — which is not a lightmap at all — has to be turned
back into pixels (TO.5).

## TO.2 The UE1 `UModel`, and the oracle that proved it

Field order is Epic's own, from `UnModel.cpp` and `UnObj.h` of the UT99 v400 source drop, and the
check is the same one the v128 reader uses: the walk has to land **exactly** on
`serialOffset + serialSize`. It does, on all 36 `.unr` files in the game's `Maps` folder.

```
[UObject props "None"] [FBox 25] [FSphere 16]
Vectors  TArray<FVector>
Points   TArray<FVector>
Nodes    TArray<FBspNode>     // no bounding sphere, no iSection - those are v128 additions
Surfs    TArray<FBspSurf>     // ends at Actor; no Plane, no LightMapScale
Verts    TArray<FVert>
INT NumSharedSides ; INT NumZones ; FZoneProperties Zones[NumZones]
cidx Polys
TArray<FLightMapIndex> LightMap ; TArray<BYTE> LightBits      // <- v128 has finished atlases here
TArray<FBox> Bounds ; TArray<INT> LeafHulls ; TArray<FLeaf> Leaves ; TArray<AActor*> Lights
INT RootOutside ; INT Linked
```

Three details that are not guessable and cost time if assumed:

* `FZoneProperties` serializes `ZoneActor`, `Connectivity` and `Visibility` — **and not
  `LastRenderTime`**, which the struct declares and the `<<` operator returns before writing.
  UE2.5 does write it, so a reader carried over from the v128 side is 4 bytes off per zone.
* 71 of the 400 mover brush models in the stock maps carry **`RF_HasStack`**, and a `UObject` with
  it writes its script state frame before its properties. Their `UPolys` do too.
* Three of the game's texture packages are still **version 61**: no GUID and no generations in the
  header (a heritage list instead), and the name table is bare C strings rather than
  length-prefixed. `../unreal/read.js` handles both shapes.

## TO.3 Scale is 1.3, and both bounds are the engines' own constants

A Tactical Ops player is UT99's: `CollisionRadius=17`, `CollisionHeight=39`, so **78 units tall**.
`KFHumanPawn` is **100** (`CollisionHeight=50`). Pawn parity is 100/78 = **1.28** — and at 1.0 the
Killing Floor player is *taller than the doorways Tactical Ops built for its own*, so scaling up is
not a matter of taste here.

The ceiling is the step. UE1's `Pawn.MaxStepHeight` is a property with a default of **25**; UE2.5's
`MAXSTEPHEIGHT` is the constant **35** in `Actor.uc`. Anything above 35/25 = **1.4** makes a
staircase the mapper was allowed to build unclimbable.

**1.3** clears pawn parity by 1% and sits under the step ceiling with room: a 25-unit step arrives
at 32.5 against the pawn's 35.

What does not survive is the jump. Both games give the player `JumpZ=325` against a gravity of
−950, so a ledge that was exactly reachable in Tactical Ops needs 1.3× the clearance here. That is a
property of the two games, not of the conversion.

## TO.4 A node's ring winds the other way round

Every node ring in a UE1 map runs the opposite way from what a UE2.5 static mesh calls the front.
Emit the fan as stored and the whole level is inside out: the near walls and the floor are gone,
and through the holes you see the backs of the far side of the map. That is the "shredded geometry"
TO-Blaze-of-Glory and TO-Blister came back with — not missing meshes, a level turned inside out.

The fan is therefore emitted against the ring (`0, i, i-1`) and the normal is the ring's own,
negated.

What settled it, after atlas pages, materials, mesh size, mesh count, bounding spheres and
triangle size had each been ruled out one build at a time: rasterise the converted `.rom` offline
from the client's own camera and cull **front** faces instead of back. The offline frame came back
shape for shape identical to the client's — same shards, same crate, same black floor. The geometry
was never missing; the client was drawing the half of it that faces away.

The winding comes from the ring, not from the node's plane. A plane is a BSP artefact — the tree
flips nodes as it balances, so 12% of them disagree with their own ring (on TO-Crossfire, 8510 with
and **1203 against**) — while the ring still carries the winding of the brush polygon it was cut
from. Orienting the fans to the plane instead was tried, and it shreds the map a second way.

The normal is Newell's sum over the whole ring rather than one cross product: a ring carries the
T-junction vertices of everything coplanar with it, so its first three points are often nearly in
line and their cross product is noise.

## TO.5 UE1 does not store a lightmap. It stores shadow BITS

This is the interesting part of the format. A v128 `UModel` carries finished DXT3 atlases; a v69 one
carries, per surface, **one bit per luxel per light** — "this light reaches this luxel" — and the
engine computes the colour at load time from the light actors themselves.

So carrying the light across means doing what the engine does. The arithmetic is Epic's, from
`Render/Src/UnLight.cpp`:

```
Radius   = 25 * (LightRadius + 1)                        AActor::WorldLightRadius
Diffuse  = |(LightLocation - SurfaceBase) . Normal| / Radius
value    = ShadowMap * Diffuse * LightSqrt[dist^2 * 4093 / Radius^2]
LightSqrt[i] = (2S^3 - 3S^2 + 1) / S,   S = dist / Radius
```

which multiplies out to `cos(incidence) * (2S³ − 3S² + 1)` — a Lambert term times a smoothstep
falloff that reaches zero exactly at the light's radius. Shadow bits are convolved with the same
3×3 tent the engine builds in `FLightManager::Init` (weights 24/40/24, 40/64/40, 24/40/24), so a
shadow edge arrives soft rather than as stairsteps of single luxels. Spotlights
(`LE_Spotlight`, `LE_StaticSpot`) get the cone term out of `spatial_Spotlight`.

Two things were checked against the files rather than assumed:

* the per-surface bit runs are `ceil(UClamp/8) * VClamp` bytes per light, laid end to end from
  `FLightMapIndex.DataOffset`, and the run ends at the first null in `Model.Lights`. Summed over
  every surface this **accounts for `LightBits` to the byte** — ratio 1.000 on the maps checked;
* every vertex of every node lands inside its own surface's `UClamp × VClamp` block under
  `u = ((P − Base) · TextureU − Pan.X) / UScale`, which is what says the luxel grid is read right.
  Luxel spacing over the stock maps runs 8–48 units, mostly 36–48.

What comes out is a relative number — UE1 finishes the luxel in fixed point through a per-light
colour palette — so `--light-gain` (3.0) is the one constant here that was set by eye rather than
measured, judged on TO-Crossfire's lit courtyard against its shadowed arcades.

The gain goes through `1 - exp(-value * gain)` rather than a multiply. A straight multiply clips
every luxel above `1/gain`, which costs the bright maps everything: TO-Thunderball's gantries came
out as white cut-outs against white walls (mean frame luminance 56 of 255, most of it saturated).
The exponential is the same curve as the multiply for the dark half — within a percent — and rolls
the top off instead of flattening it; the same frame reads 27 with the structure visible.

Where the atlas meets a surface that does not draw plainly, the order of the material chain is the
whole game: the Combiner that multiplies the atlas into the texture is the Shader's **Diffuse**, not
a wrapper around the finished Shader. Built the other way up, every fence and every door in the
level draws as a flat white panel with neither texture nor cut-out left (GOTCHAS 5.41).

## TO.6 The atlas: pack the tallest block first, then crop

A map's light meshes are 4×4 to 200×180 luxels and there are thousands of them (TO-Crossfire: 3857
blocks, 234k luxels). Packed in the order the surfaces come, every shelf ends up as tall as the one
big block that opened it: **two 1024×1024 pages, 88% of them air** — and an atlas is the biggest
single thing in the finished file.

Sorting the blocks by height before packing and cropping each page to the power of two that covers
what was used puts the same map in **one 1024×512 page**, and the `.rom` from 20.9 MB to 12.9 MB.

## TO.7 The sky is a room somewhere off the map

UT99 draws its sky by rendering a small room — the one holding the `SkyZoneInfo` — through every
surface flagged `PF_FakeBackdrop`. Killing Floor has the same machinery, but only for BSP surfaces,
and here the world is static meshes.

So the room is lifted out of the level: its nodes are the ones whose zone is the sky zone, and they
are scaled about their own centre until they enclose the level and re-centred on it. The result is
the same picture with parallax, which is what the Quake 3 route's cube gives too — TO-Avalanche's
moon comes across, and so does its snow.

Three rules that had to be added to make it work:

* the room's own textures are **dimmed by 1/2.4** like any sky (GOTCHAS 5.15), since they are drawn
  unlit;
* the room is drawn one-sided, like the rest of the world. Blowing it up puts the player inside it,
  which is exactly the side its walls were wound for once TO.4 is applied — doubling the triangles
  to be safe was tried, and it is not needed;
* UT99 layers its sky — an opaque picture with one or two `PF_Translucent` cloud sheets panning
  over it, three of the four in TO-Crossfire's room. Nothing here reproduces a panning sheet, and an
  additive one over the hole a backdrop surface leaves is white glare, so **the overlays are dropped
  wherever the room has an opaque layer to keep**.

## TO.8 Movers are the only geometry that is not in the BSP

A mover is an actor with a `UModel` of its own, and the only copy of its geometry is that model's
`UPolys` — the CSG source polygons, in the brush's own space, waiting to be placed by the actor's
`Location`, `Rotation`, `PrePivot` and the two scales UnrealEd carries. **400 of them over the 34
files, 5569 polygons**, and TO-TerrorMansion alone has 62 doors and 43 panes of glass.

Anything that actually moves becomes a `KFDoorMover` with the `KFUseTrigger` that wakes it — opened
with the use key and weldable, like a native Killing Floor door — because a door left shut seals a
corridor for good. `KeyPos(1)` carries straight over: UE1 keeps its keys as offsets from `BasePos`,
which is exactly what a `KFDoorMover`'s key means. Glass panes stay where they are: in Tactical Ops
they are shot out rather than opened.

A mover's polygons obey the same winding rule as the world (TO.4) — their fans run against the
poly's own outward normal — and they carry no lightmap, since the atlas is built from BSP light
meshes and a mover is not in the BSP. Left at full brightness beside a world that draws its texture
multiplied by an atlas whose mean is 54 of 255, a mover is five times brighter than the wall it is
set into: TO-TerrorMansion's cream door came out as a white rectangle. Every unlit mesh therefore
carries `ScaleGlow` = the atlas mean, floored at 0.25 — the one multiplier in Killing Floor that
goes down rather than up.

## TO.9 Textures are palettised, and the mask is index 0

All 3054 textures in the install are `TEXF_P8`, and 3047 of them carry a `UPalette`; five have no
pixels at all (the procedural `WetTexture`s). Some carry a DXT1 `CompMips` cache **beside** the
palettised master, and the master is what gets read - the cache is what the old software renderer
built at load time, not a better copy.

Unreal masks on palette index **0**; Half-Life masks on 255, and the writer here is the one built
for Half-Life. A cut-out is therefore handed over with 0 and 255 swapped and comes out the other
side exactly as it went in — which also buys the fringe-bleeding and the indexed mip chain that
writer already does.

**Which surfaces are cut-outs is the TEXTURE's answer, not only the surface's.** UT99 ORs
`UTexture.PolyFlags` — which carries `PF_Masked` for every `bMasked` texture — into the surface's
flags at draw time, and mappers lean on it: on TO-GlasgowKiss 25 of the 47 surfaces wearing
`coneymsk14` have no `PF_Masked` of their own, and on TO-Crossfire all 54 of `coneymsk13` have
none. Reading only the surface flag leaves those drawn opaque, so the mask colour shows as a solid
rectangle — black behind a bridge railing, magenta behind a fire escape, red behind a sign,
whatever palette index 0 happens to be. The rule here is the engine's: masked if the surface says
so **or** the texture does.

Opaque textures go out as **DXT1**, not "DXT3 with an opaque alpha channel": a projector landing on
the latter repaints the whole surface white (GOTCHAS 5.16), and it is half the bytes.

Surface coverage over all 33 maps: **198818 of 198896 surfaces resolve their texture** (99.96%).
What does not is 19 surfaces wearing the editor's own `Editor.Bad` placeholder and a handful of
procedural steam textures; they get a flat grey stand-in.

### Water is a program, not a texture

A UE1 water surface wears a `WetTexture` (`Texture` → `FractalTexture` → `WaterTexture` → this):
its pixels are computed every frame by distorting a still image with a wave field, and what the
package stores is the flat buffer that program writes into. Carried at face value, TO-Crossfire's
canal came out as a slab of one khaki colour.

The still image is named by the texture's own `SourceTexture` property (`bwateranimold` →
`bwatercliff`), so that is what gets carried and the water reads as water. What is lost is the
ripple, which is generated code with no equivalent here.

## TO.10 Player starts: all of them, and on the floor

A Tactical Ops map has 26–43 `PlayerStart` actors, placed in team pairs — taking the first 32 of
them (as the Quake 3 route does with its own) would put a whole team in one corner, so **every one
is carried across**.

Two checks stand behind that. A start whose own point classifies as solid in the BSP is dropped:
carried across it spawns the player inside a wall. And the pawn is stood on the floor traced under
the start rather than on the assumption that both games' pawns sit the same height above their own
feet — the measured drop from a start to the floor under it is 33–42 units against the UT99 pawn's
half-height of 39, and the KF pawn is 11 units taller.

## TO.11 Water is a zone, and a zone has to become a box

Tactical Ops marks water the way UE1 does: a BSP zone with a `WaterZone` actor standing in it. Zones
do not survive the trip to static meshes, so what carries across is a **box around that zone's own
geometry**, written as a `PhysicsVolume` with `bWaterVolume` — which is what Killing Floor reads to
decide the player is swimming, and where the underwater tint comes from.

The floor of the box is lifted 46 uu, for the reason the GoldSrc route lifts its own: which volume
an actor is in is decided by its centre, a standing `KFHumanPawn`'s is at 50 and every zed's at 44,
so a band that thin keeps the player wet and the zeds walking. A zone too shallow for that keeps its
whole box and carries only the tint. TO-RapidWaters gets four of them.

What the box costs is the shape: a river bending through a canyon becomes the rectangle around it,
so there is water in the air at the outside of the bend.

## TO.12 What a Tactical Ops map carries that this does not

* **Zones and portals.** One zone for the whole level, so there is no PVS occlusion — the same
  place the other three routes are.
* **The game.** Bomb spots, hostages, `s_ZoneControlPoint`, the ladders (`TO_Ladder`), the
  scenario info — all of it is Tactical Ops gameplay with no Killing Floor equivalent. What comes
  across is the place, not the round.
* **Everything animated.** Panning textures (`PF_AutoUPan`/`AutoVPan`), the flames, the rain
  generators and the `ScaledSprite` decorations arrive as their first frame or not at all. Water
  keeps its picture and loses its motion (TO.9): the still image a `WetTexture` distorts is carried,
  the wave field is not.
* **Bot paths, zombie volumes, the trader.** As on every other route: a converted map has nothing
  to fight until somebody places them.

## TO.13 What a stock map costs, measured

Converted with the defaults and verified with `--verify`:

```
TO-Trooper          9631 tris    224 meshes  1 atlas   7.5 MB
TO-Crossfire       23492 tris    476 meshes  1 atlas  12.9 MB
TO-Avalanche       39925 tris    649 meshes  1 atlas  20.9 MB
TO-TerrorMansion   27554 tris    716 meshes  2 atlas  21.3 MB   (105 movers)
TO-KnightsEdge-B1  58992 tris    643 meshes  2 atlas  30.9 MB
TO-Blaze-of-Glory  79272 tris    812 meshes  2 atlas  33.4 MB
```

All 33 stock maps convert, pass all 31 invariants of the finished `.rom` and reach a live
first-person view in the client with no `Critical:` line in `KillingFloor.log`.

The 3.5 install ships 20 more — the community `TO-2-*`, `TO-2W-*`, `TO-AoT-*` maps and a few
one-offs — and all 20 convert and verify as well, which is what says the reader is reading the
format rather than the habits of one mapping team.
