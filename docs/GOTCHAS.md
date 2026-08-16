# GOTCHAS — the Killing Floor side

Everything that cost time while writing to Killing Floor's format — Unreal Engine 2.5, package
version 128/29 — written down so it does not have to be rediscovered. Each entry is a fact that was
*measured* against the shipped game files or observed in the running client, not a guess.

**This file is the TARGET.** It holds what every conversion has to satisfy whatever it is reading:
the package layout, the world model, the zones, static meshes, how the renderer behaves and what
kills it. What each SOURCE game costs is in its own file, because there will be more of them:

| source | notes |
|---|---|
| Counter-Strike 1.6 / GoldSrc | [`games/goldsrc.md`](games/goldsrc.md) |
| Lineage 2 (Interlude) | [`games/lineage2.md`](games/lineage2.md) |

The line between them: a fact about `.bsp` faces, WADs, `.mdl` props or `Lineage2Ver111` belongs to
its game; a fact about `UModel`, `UStaticMesh`, karma or the renderer belongs here, because the next
front end will hit it too. Entries keep the numbers they had while this was one file — the code
cites some of them — so the sequence has gaps where things moved out.

Companion notes: [`RESEARCH.md`](RESEARCH.md) (the format research), [`../README.md`](../README.md)
(how to run the tool).

---

## 1. Package / serialization

### 1.1 `PropType.Str` is 13, not 7
`Type mismatch in Title of LevelSummary: file 7, class 13` — the UE2.5 property type table puts
`Str` at 13. Type 7 is the old UE1 `String`.

### 1.2 Actors need `RF_HasStack` **and** a full `FStateFrame`
Without it the engine dies in `ANavigationPoint::Destroy` at level teardown. The frame is
`cidx Node, cidx StateNode, QWORD ProbeMask=0xFFFFFFFFFFFFFFFF, INT LatentAction=0xFEFEFEFE,
cidx Offset=-1`, with `Node`/`StateNode` both pointing at the actor's class.

### 1.3 Every actor needs `Level`, `Region`, `PhysicsVolume`, `Tag`
Missing `Level` is a null dereference during `Destroy`. `Region` is a `PointRegion` struct written
as a nested tagged-property block (`Zone`, `iLeaf`, `ZoneNumber`).

### 1.4 The `FBspSurf` field that looks like `iBrushPoly` is an object reference
Writing a polygon index there produces `Bad export index 325/325` on load. It is `Actor`; write
`None` (0).

### 1.5 `TLazyArray` skip offsets are **absolute** file offsets
Both in `UModel`'s lightmap textures and in `UStaticMesh`'s `RawTriangles`. They must be patched
after the array is written, not computed as a length.

### 1.6 Object.assign copies an explicit `undefined`
Not an Unreal gotcha, but it silently disabled the default `geometry` mode for a whole debugging
round: `Object.assign({}, DEFAULTS, {geometry: undefined})` yields `geometry: undefined`.

### 1.7 `packageFlags` is 0x00000001, and the extra bit is not cosmetic
Every shipped Killing Floor map, and every hand-built CS port, carries exactly `PKG_AllowDownload`:

    KF-Farm, KF-Crash, KF-CS-AIM-Headshot-KFN, KF-CS-33-Comity-KFN   packageFlags 0x00000001
    this writer, for a long time                                     packageFlags 0x00000021

0x20 is not a flag the engine documents. It was also the single byte `test/repack.js` could never
reproduce when rebuilding a shipped map - the difference was measured, written down as "one byte
(packageFlags)", and treated as noise for months. It is the first thing to suspect when the editor
loads a map and then refuses to do something to it: the whole package is described by this word,
so a wrong bit disqualifies everything inside it at once, with no error and nothing wrong in any
individual object.

### 1.8 `FColor` is B, G, R, A on disk
Not RGBA. The engine's own text form says so - a KFEd `.t3d` writes
`DistanceFogColor=(B=108,G=182,R=255)`. Writing R first swaps the red and blue channels of every
colour property, which is invisible on the near-grey fog this converter derives from luxels and
obvious on anything saturated: the underwater overlay was authored `40,90,130` and tinted the
screen RED for months. `build/mesh.js` and `build/propmesh.js` had it right for vertex colours
(`[hl[2], hl[1], hl[0], 255]`); the property writer did not.

---

## 2. UModel (the world BSP)

### 2.1 Field order after `Verts` is the UT2004 one
The UE1 order (`LightMap`/`LightBits` straight after `Polys`) is a dead `Ver<105` branch in UE2.5.
The live order is:

```
Vectors, Points, Nodes, Surfs, Verts,
INT NumSharedSides, INT NumZones, FZoneProperties Zones[NumZones],
cidx Polys, TArray<FBox> Bounds, TArray<INT> LeafHulls, TArray<FLeaf> Leaves,
TArray<cidx> Lights, INT RootOutside, INT Linked,
TArray<FBspSection>, TArray<FLightMap>, TArray<FLightMapTexture>
```

Verified by hitting `serialSize` exactly on 362 of 362 shipped maps.

### 2.2 The renderer follows `iSection` and `iLightMap` without checking for −1
A node with a polygon (`NumVertices >= 3`) and `iSection = -1` indexes `Sections(-1)` and corrupts
the heap. Same for `iLightMap`. Every drawable node needs valid indices — sky and water faces get a
flat 2×2 lightmap block rather than being left at −1.

### 2.3 `LeafHulls` ends with six trailing floats per hull
An AABB (min xyz, max xyz) after the plane-index list and its −1 terminator. Omitting it makes the
engine read past the array.

### 2.4 A `Model` with **zero nodes is solid, not empty**
This one cost the most time. With `Nodes.Num() == 0`, `ULevel::SpawnActor` refuses to place any
colliding actor:

```
Warning: SpawnActor failed because class Pawn is abstract
ScriptLog: Couldn't spawn player of type KFmod.KFHumanPawn at KF-CS-Assault.PlayerStart0
```

…and KF then ends the round as a squad wipe before a frame is ever drawn. **A level whose visible
content is static meshes still needs a real BSP.**

### 2.5 `iLeaf` on a node must be −1 unless `Leaves`/`Lights` are populated
`FLeaf.iPermeating` / `iVolumetric` index the `Lights` array. Pointing a node at leaf 0 of a model
with an empty `Lights` array crashes in `FLevelSceneNode::Render` →`FMallocWindows::Free`. Every
node of every shipped map carries `iLeaf = [-1, -1]`.

### 2.6 `UModel::LineCheck` reads `Verts(iVertPool)` for every node it visits
A node with `NumVertices = 0` and an empty `Verts` array reads off the front of the heap:
`Critical: UModel::LineCheck / CheckWithLevel / ULevel::MultiLineCheck`.

### 2.7 Coordinates beyond ±262144 (`HALF_WORLD_MAX`) are not clamped, they are wrong
A node plane at `z = -1e6` produced a level that loaded, spawned and collided correctly and
rendered pure black. Keep every plane, vertex and bound inside the world extent.

### 2.8 SOLVED: `RootOutside = 0` is what makes the editor able to rebuild the map at all
`RootOutside` says what the space OUTSIDE the tree is: **0 = solid rock, 1 = open air**. Every
shipped map and every hand-built CS port carries 0, and this converter carried 1 for months because
1 looked like the safe value for a token box.

It is the premise the editor's CSG works from. `bspBrushCSG` subtracts a brush by filtering its
polygons through the world tree, and **subtracting air from air produces nothing**: Build Geometry
walked to our brush, entered `bspBrushCSG` exactly once (measured with an in-process call counter),
and came back with an empty model - no error, no warning, nothing in the log. With 0 the same brush
carves the room and the editor rebuilds the level correctly.

Two things follow from shipping 0, both measured in the game:

- Everything beyond the room is now solid, so an actor out there sits in zone 0 and the renderer
  skips it. The skybox cube is parked at 6x the level radius (5.17a) - far outside the level's own
  bounds - so the room has to be grown to hold it or the sky comes out flat grey.
- The earlier note that 0 "makes the renderer draw no world at all" was wrong. It was measured while
  `iRenderBound`, the zone/leaf layout and the sky were all being changed at once (2.12), and the
  blame landed on the wrong field.

`Linked` is 0 in shipped world models; brush models carry 1. `KF_ROOT_OUTSIDE` forces either value.

### 2.9 The world model's bounding box is empty, a BRUSH model's must not be
For the world model, `valid = 0` and all zeros is what shipped maps carry; the engine derives it,
and filling it in was the only field that differed on the byte-exact repack test.

A brush's model is the opposite: every subtract brush in KF-Farm, KF-Crash, KF-Aperture and the
hand-built CS ports carries a real box with `IsValid = 1`, a real bounding-sphere radius and
`NumSharedSides = 4`. Ours shipped zeros with `valid = 0` - a brush that declares it occupies
nowhere - and anything that culls by bounds drops it silently.

### 2.10 UModel::LineCheck walks Verts for every node it visits
A node with `NumVertices = 0` makes that walk address `Verts(iVertPool - 1)`. It only faults when
a trace actually reaches the node, so it shows up as an intermittent crash from something that
traces - `Pawn.UpdateEyeHeight -> ULevel::SingleLineCheck -> UModel::LineCheck` - roughly 1 run in
10 and never at load. Give every node a real polygon.

NOT PROVEN: the fix follows the invariant, but the crash could not be reproduced here - 12 runs of
the PRE-fix build were clean too, because reproducing it seems to need the lobby -> Ready path
rather than `?QuickStart=1`. Treat as plausible, not confirmed.

### 2.11 A node with a polygon needs a real material too
Once `NumVertices >= 3` the node reaches the render-section pass, where the surface material is
followed without a null check, so `material: 0` (None) is not safe there.

### 2.12 SOLVED: `iRenderBound` is the SUBTREE's box, and getting it wrong hides the whole level
The longest-running bug in this project. The symptom: for as long as the view was held a certain
way, the entire world stopped being drawn - no BSP surface, no static mesh, no actor - leaving the
frame at the zone's clear colour with the first-person weapon and the HUD still crisp on top of it.

The cause, in `build/model.js`:

```js
for (const n of nodes) {
  if (n.numVertices < 3) continue;
  ...bbox of THIS node's own polygon...
  n.iRenderBound = bounds.length;
}
```

`iRenderBound` is the bounding box of the node's **entire subtree**. The renderer tests it against
the view frustum and, when it misses, skips that node *and everything below it*. Writing the node's
own polygon there is not a tighter bound - it is a false claim about where the rest of the tree is,
and the engine acts on it. This converter's tree is a chain, so the moment the ROOT node's own
polygon left the frustum the whole level was culled.

Compute it bottom-up: a node's bound is its polygon united with the bounds of its front, back and
coplanar subtrees. Memoise, and guard against a cycle. In the fixed cs_assault the root node's
bound is the whole enclosing box and the last node's is its own quad alone.

Every symptom follows from this one line, which is why nothing else fixed it:

* **view-direction dependent** - the root's polygon entering and leaving the frustum;
* **the whole world at once** - one subtree is the whole tree;
* **identical on the static-mesh route and the BSP route** - both are reached through the walk;
* **weapon and HUD unaffected** - the HUD pass does not go through the tree;
* **never on a shipped map** - the editor computes these bottom-up;
* **"almost always" instead of "sometimes"** when the open leaf was moved onto the last node alone -
  same walk, fewer chances to reach anything.

Ruled out along the way, each by a test in the running game and each wrong: the sky textures (a
build wearing a stock KF sky still did it), the skybox mesh entirely, the lights, the sprites and
`.mdl` props, the doors and glass, truncated mip chains (a real defect, fixed separately, not this),
KF's full-screen HUD overlay (disabled with a `KFSPLevelInfo` and measured as disabled - 43.8 against
83.2 at the same spawn - and the flashes stayed), the world BSP being a single node, `bStatic`,
`RF_Standalone`, and `RootOutside`.

**The lesson worth keeping:** an index into a structure the engine walks is a *claim about the whole
structure*, not a local detail. When a symptom is "everything, sometimes", look for a field that
speaks for more than the object it sits on - and check what the engine means by it, not what it
would be convenient for it to mean.

---

## 3. Zones, and why nothing renders

### 3.1 Zone 1 must have a real `ZoneInfo` actor
Every shipped map has one (`Zones[1].ZoneActor` → a `ZoneInfo` export). A level with
`ZoneActor = None` still draws its BSP, so the problem looks like a static-mesh problem rather than
a zoning one.

### 3.2 Zone 0 is the null/solid zone
`iZone = [0, 1]` on a drawable node means "solid behind, open in front". No shipped map has a
drawable node whose *front* zone is 0.

---

## 4. UStaticMesh

### 4.1 Serialization order

```
props (Materials array), FBox(25), FSphere(16),
Sections TArray<14 B>, FBox(25),
VertexStream TArray<{FVector Pos, FVector Normal}> + INT Revision,
ColorStream TArray<FColor> + INT, AlphaStream TArray<FColor> + INT,
UVStreams TArray<{TArray<FMeshUVFloat(8 B)> + INT CoordIndex + INT Revision}>,
IndexStream1 TArray<WORD> + INT, IndexStream2 TArray<WORD> + INT,
kDOP: cidx 0, TArray<FkDOPNode(32 B)>, TArray<FkDOPCollisionTriangle(8 B)>,
RawTriangles: TLazyArray = INT skipOffset (absolute) + cidx N + N elements,
10-byte trailer
```

Byte-exact round-trip on 434 of 470 shipped meshes.

### 4.2 `FStaticMeshSection`'s fourth WORD repeats the face count
`INT unused, WORD FirstIndex, WORD FirstVertex, WORD LastVertex, WORD NumFaces, WORD NumFaces`.
Leaving the fourth WORD at 0 makes the engine skip the mesh silently on the `bStatic` path and
**crash** (`FLevelSceneNode::Render` → heap corruption) on the dynamic path.

### 4.3 The two ints after a UV stream are `CoordIndex` then `Revision`
Shipped meshes carry `0, 1`. Writing `1, 0` gives the stream revision 0.

### 4.4 `AlphaStream` has one entry per vertex in every shipped mesh
Not optional in practice.

### 4.5 `IndexStream2` is the wireframe edge list
Deduplicated triangle edges, two indices each. KFEd's orthographic viewports draw from it.

### 4.6 `FStaticMeshTriangle` is variable-size
`3 × FVector (36 B) + INT NumUVSets + 3 · NumUVSets × UV(8 B) + 3 × FColor (12 B) + INT Smoothing +
INT Material` — 84 B with a single UV set. The trick that found `RawTriangles` at all: its
`TLazyArray` skip offset is an absolute offset *into the same object*, so the array can be located
by scanning for a plausible self-reference, after which the kDOP block is whatever is left and can
be solved by brute force over (lead, nodeSize, triSize).

### 4.7 kDOP node semantics
32 B = `FLOAT Min[3], FLOAT Max[3], UBOOL bIsLeaf, WORD, WORD`.

* internal node: `bIsLeaf = 0`, the two WORDs are the left and right child indices
* leaf node: `bIsLeaf = 1`, the WORDs are `NumTriangles` and `FirstTriangle`

Leaves address a contiguous run of the collision-triangle array, so triangles are emitted in tree
order. Both WORDs are 16-bit: at most 65535 triangles and 65535 nodes per mesh. Shipped meshes use
about 5 triangles per leaf. **Without a kDOP tree a static mesh is scenery you fall through.**

### 4.8 `UseSimpleBoxCollision` / `UseSimpleLineCollision` are spelled without the `b`
And they are properties of `UStaticMesh`, not of the actor.

### 4.8a Karma will eat all your memory if the mesh has no karma primitives
`UseSimpleKarmaCollision` defaults to true. At level load the engine walks
`BeginPlay -> KInitActorKarma -> KInitActorCollision -> KCreateActorGeometry ->
KAggregateGeomInstance -> FMallocWindows::Malloc` for every actor using the mesh, and with nothing
to build from it allocates until the process dies with "Ran out of virtual memory". Emit
`UseSimpleKarmaCollision=False` on the mesh and `bBlockKarma=False` on the actor.

### 4.8c UseSimpleKarmaCollision=False is required on every walkable mesh
Without it the engine walks KInitActorKarma -> KCreateActorGeometry -> KAggregateGeomInstance for
every actor using the mesh and allocates until the process dies of "Ran out of virtual memory". The
converter emits it False on every mesh it makes (unreal/staticmesh.js). Do not "tidy it away" -
nothing in the file says why it is there.

### 4.8d `bBlockKarma=False` is why the corpses fall through the floor
`Actor.bBlockKarma` is "Block actors being simulated with Karma" (Actor.uc:561) and a ragdoll is
exactly that, so an actor with it off is one every corpse drops straight through. It was turned off
alongside `UseSimpleKarmaCollision` to stop the malloc storm above, and that was one flag too many:
the storm is `KAggregateGeomInstance` building simple hulls out of a mesh that has none, and
`UseSimpleKarmaCollision=False` already sends Karma to the kDOP triangles instead.

`StaticMeshActor`'s own default is True, and the hand-built KF port of ka_legoland leaves it there -
its bodies rest on the floor while the converted map's fall through, same level, same meshes.

Measured with it back on: ka_legoland loads and plays, and zp_kievpass - 1227 mesh actors, the
biggest map in the set - loads too, no allocation storm. `KF_NO_KARMA=1` goes back to scenery that
nothing can rest on.

What it needs to be safe is a collision tree with no zero-area triangles in it - see 4.8e, which is
the same flag's second failure and looks nothing like the first.

### 4.8e A collinear triangle in the collision tree deletes the corpse
Turning `bBlockKarma` on made the bodies stop falling through the floor and start vanishing in
mid-air instead - no fall, no body, just blood and gibs. The log says why:

```
Log: (Karma:) Bad Normal Length: 0.000000
```

Karma reads the mesh's kDOP triangles as the level's world collision, and a triangle whose three
points are on one line has a face normal of length zero. The contact goes NaN, the ragdoll leaves
the level, and `KFMonster`'s `ZombieDying.Timer` destroys anything the player cannot see two seconds
later - so the corpse is gone before it lands.

They are not rare. GoldSrc face rings carry the vertices of their neighbours' T-junctions, and a fan
over such a ring produces one degenerate triangle per extra vertex:

| map | triangles | collinear |
|---|---|---|
| ka_legoland | 3306 | 293 (8.9%) |
| zm_rooms | 3078 | 342 (11%) |
| cs_assault | 9407 | 694 (7.4%) |
| zp_kievpass | 21978 | 1259 (5.7%) |

Every one of them EXACTLY collinear, none with a repeated vertex, which is why the test in
build/mesh.js can be a strict zero rather than a tolerance. Dropped at the point the triangles are
emitted, so they leave the index stream and the collision tree together; the fixed build logs 0 of
those Karma lines against 27 for the same fight before it.

The reason none of this showed for years: with `bBlockKarma=False` Karma never built world collision
at all, so it never read the triangles. A control build with the flag off logs zero Karma lines.

### 4.8b The mesh serializer is not the problem - measure it correctly
`writeMesh` reproduces **4377 of 4377** shipped static meshes byte for byte. An earlier figure of
434/470 was a broken measurement: the `TLazyArray` skip offset is an absolute file offset, so a
round-trip that patches it at base 0 instead of the export's own offset differs ~24 KB in, on every
mesh whose offset is not 0.

### 4.9 `UStaticMeshInstance` is the per-actor baked lighting
`props (None) + TArray<FColor> (one per mesh vertex) + INT 2 + cidx 0`. The colour count matches the
mesh's vertex count exactly (checked against embedded meshes in `KF-Farm.rom`: 130↔130, 1506↔1506).
The larger shipped instances carry per-light shadow records after the trailing `cidx`; the minimal
shipped instance is 23 bytes and ends right there.

### 4.10 How a Killing Floor map is actually lit, and what that costs a converter
Four facts, measured, in the order they matter:

1. **A GoldSrc `light` entity is a compiler input.** `hlrad` bakes it into the lightmap and the
   entity does not exist at runtime. "The lamp lights the room in CS" IS the baked lightmap.
2. **`Engine.Light` is the same kind of thing** - `bStatic`, `bNoDelete`, no `bDynamicLight` - so
   it contributes only while UnrealEd bakes. Place fifteen of them in a converted map and the
   running game is not one lumen brighter.
3. **A `StaticMeshActor` takes its light from `StaticMeshInstance`** (`bStaticLighting=True` by
   default, and `Actor.uc:321` calls that object "per-instance static mesh data, like static
   lighting data"). No Build, no light: the zone's ambient is all a converted map has, which is
   why it reads flat next to the original.
4. **That static lighting is per VERTEX, not a lightmap.** Only BSP surfaces get lightmaps. A CS
   face is up to 240 units across, so a Build over unsplit faces puts light at their corners and
   nowhere else - hard dark wedges at chunk boundaries, which is exactly what a mapper's rebuild
   of these meshes produced.

`Gameplay.Sunlight` is the real directional-sun class - not in `Engine`, which is why this file
once claimed KF had none. A hand-built KF port of a CS map carries one at `LightBrightness=25` with
`bActorShadows`, sixteen `Light`s at brightness 0 with `bCorona` for the lamp glows, and
`ZoneInfo.AmbientBrightness=8`: everything visible is baked from that one sun.

So there are two honest ways to ship, and `--lighting` picks between them:
* `ambient` - the zone lights the level, because nothing else will. Plays as converted; flat.
* `sunlight` - a Sunlight, ambient 8, and extra vertices split into the faces whose GoldSrc luxels
  actually vary (graded by contrast: 3 levels of splitting over 90, 2 over 40, 1 over 20 - splitting
  everything cost 5x the triangles for detail half the map has no use for). Dark until KFEd builds
  the lighting, right afterwards.

* `dynamic` - clear `bStaticLighting` on the meshes and set `bDynamicLight` on every light, and the
  engine lights the level every frame with no build at all.
* `lightmap` - carry GoldSrc's own baked light across as a texture. The only one that MATCHES the
  original, because it is the original: see 4.11.

Whichever way, the ambient ceiling is 64: an unlit surface reads about 2.5x its texture (5.15), so
gg_death_arena measured 80, shipped at 96 and burned to white.

### 4.10a What each flag actually does, measured
Four rounds of "the sun changes nothing" came down to these, in order:

* **`bStaticLighting`, not `bStatic`, is the lighting flag.** Clearing both works and clearing
  `bStatic` also makes KFEd report *"bStatic false, but is bStatic by default - map will fail in
  netplay"* once per mesh. Killing Floor is co-op. Clear only `bStaticLighting`.
* **A light with no `bDynamicLight` does not exist at run time.** `Light.uc` is `bStatic=True` with
  the flag unset, which means build-time only: the sun could be set to 20, 60, 100 or 150 with no
  difference on screen, because none of it ever reached a surface. `GamePlay.TriggerLight` is the
  one map-placed light in the SDK that lives during play, and it spells out `bStatic=False`,
  `bMovable=True`, `bDynamicLight=True` - of which only the last is wanted for a lamp that stays put.
* **The mesh colour stream ADDS to the lighting, it does not modulate it.** Three probe builds on
  gg_dustwars: colours 0 with no lights is black, colours 0 with lights looks lit, colours 128 with
  the same lights burns to white. Those colours hold the GoldSrc luxel (mean 128-180), so a
  dynamically lit map has to ship the stream at zero or every surface carries a second light nobody
  can turn down.
* **A directional light lands hardest on what faces it.** The ground is perpendicular to the sun and
  took a full hit while the walls took a graze - saturated yellow sand beside walls that looked
  right. A fill light aimed DOWNWARDS makes that worse, not better; bounce comes off the ground, so
  the fill has to point up.

### 4.11 THE LIGHTMAP ROUTE: the map's own light, carried as a texture
Everything Counter-Strike shows - the shadow a building drops, the pool under a lamp, the
half-tones hlrad bounced - is in the .bsp at one luxel per 16 units. No arrangement of Unreal lights
reproduces it: a real-time light casts no shadow on world geometry and does not bounce, so tuning
brightness is all that is left, forever. Carry the luxels across instead.

* **Pack them into 512x512 atlas pages** with a one-texel border of edge repeat, or bilinear
  filtering samples the neighbour packed beside it. gg_dustwars: 3054 lit faces into 3 pages.
* **The mapping is exact, not fitted.** GoldSrc's luxel coordinates come out of texinfo:
  `s = dot(p, ti.s) + ti.sShift`, `luxel x = s / 16 - hl.baseS`, plus half a texel to land in the
  middle of one.
* **Write it as a second UV stream.** `UVStreams` is an array; stream 0 is the texture, stream 1 the
  atlas, and their `CoordIndex` is what names the channel. RawTriangles must carry `numUV = 2` as
  well, or KFEd rebuilds the mesh from triangles that disagree and the channel is gone.
* **`TexCoordSource=TCS_Stream1` is what steers the sampler - `SourceChannel` is not.** Measured
  with three builds of one map: the enum alone is right, both together are identical to it, and
  `SourceChannel` alone bands the whole level.
* **`Combiner` has no masked output.** A cut-out texture multiplied by the atlas draws its
  transparent half solid - gg_trs_aim_churches' `{ladder1` came out a red slab. Hang the combiner
  off a `Shader` with `Opacity` = the same texture and `OutputBlending = OB_Masked`.
* **The meshes stay LIT - the combiner is their `Diffuse`.** The baked light then sits inside the
  surface the engine lights, so hlrad's shadows are on the wall AND the torch and the muzzle flash
  land on top of them. `bUnlit` draws the same picture but `Actor.bUnlit` is "Lights don't affect
  actor" (Actor.uc:464): nothing the player carries ever reaches a converted wall, which is what
  every build before this one did. `KF_LM_UNLIT=1` goes back to it.
* **`Shader.SelfIllumination` cannot give you both.** The obvious fix - baked picture in
  `SelfIllumination`, plain texture in `Diffuse` for the dynamic light to land on - does not work:
  measured over five builds of cs_assault, this engine draws the self-illuminated half OR the lit
  Diffuse and never both, and writing a `SelfIlluminationMask` of ANY value (0, 128, 255) is what
  flips it to the lit one. With no mask: right picture, no torch. With a mask: torch and muzzle
  flash work, every hlrad shadow gone.
* `Modulate2X` doubles, the way GoldSrc's own renderer doubles its lightmap - which turned out to be
  one doubling too many here.
* **The luxels go in at 1.0 against a level light of 40**, split 8 in the zone and 32 in the mesh
  actors' `AmbientGlow` - see §4.11a for why it cannot all sit in the zone. It is a plain multiplier
  on the atlas, so it is the SAME for every map: what varies from map to map is already in the
  atlas, and a per-map value would count it twice. Measured on cs_assault against 1.7 and 2.5, which
  blew the lit half of the level out.
* **And a floor of 16 under the atlas**, because the multiply means a luxel of 0 takes no light at
  all - §4.11b.
* The unlit route keeps its own number, 0.55: an unlit surface reads about 4x its material, so
  `255 / (128 * 4)` lands on the same screen value - judged against Counter-Strike side by side on
  gg_trs_aim_churches, where 0.8 still washed the wall out. The app's light multiplier scales
  whichever is in use, so a whole level dims or lifts from one field.
* **The torch is a projector plus a light** (`Effect_TacLightProjector` + `Effect_TacLightGlow`).
  The projector draws its own spot on any surface and never depended on this; the light has
  `LightRadius=3` and fades with beam length, so it only shows close up.

### 4.11b A luxel of 0 is a surface no light can ever reach
The lit route's whole point is that the baked light sits inside the wall's `Diffuse`, so what the
engine lights is `texture x atlas`. Where hlrad left the atlas at 0 that product is 0, and so is
everything downstream: torch, muzzle flash, lamp, ambient. The flashlight lights nothing in those
rooms, and no flag fixes it because nothing is missing - it is a multiply by zero.

How much of a map this is varies wildly, per lit luxel, area-weighted:

| map | luxels at exactly 0 | below 16 |
|---|---|---|
| zm_rooms | 64.5% | 75.1% |
| gg_dustwars | 3.4% | 4.6% |
| cs_assault | 0.0% | 22.3% |

The floor under the atlas leaves the darkest surface a little of its texture for a light to land on.
It lifts hlrad's deepest shadows by the same amount, which is why it wants to be small. Judged on
zm_rooms against 8 and 32: **16** is the default, `KF_LM_FLOOR=<0..255>` overrides it.

Note what it does NOT fix: the torch is a projector plus a light of `LightRadius=3` (§4.11), so even
on a floored atlas it only reaches what is close.

### 4.11a The zone ambient is the ONLY light on the player, and `AmbientGlow` splits it off the world
Measured on ka_legoland, one build per row, everything else equal:

| ZoneInfo.AmbientBrightness | StaticMeshActor.AmbientGlow | the world | the player |
|---|---|---|---|
| 40 | - | right | too bright - the complaint |
| 10 | - | dark | dim |
| 0 | 40 | right | a black silhouette |
| 10 | 30 | right | right |

**8 + 32 is what shipped**, judged against 16+24 and 24+16 on ka_legoland and then on five more maps
from both ends of the range (gg_gardenworld_cs16 is the brightest of the 227, zm_rooms the darkest).
The props get the glow too: a truck stands IN the world, not in the pawn's place, and without it the
split left it four times darker than the wall behind it.

Two facts fall out of the table:

* **`AmbientGlow` adds to the zone ambient, per ACTOR, and the two are worth the same.** 0+40 and
  10+30 light the wall identically. So the world's share can live on the mesh actors and the zone
  ambient is free to be whatever the pawn needs - one number no longer has to serve both.
* **A static light reaches the pawn no more than it reaches the wall.** At ambient 0 the player is
  pure black with `Gameplay.Sunlight` at brightness 50 and nine `Light`s at up to 136 standing in
  the level. §4.10's "a static light contributes nothing at run time" holds for dynamic actors too;
  everything the player, his hands and the zeds show comes from the zone.

The mapper's side of the same fact: a hand-placed KF static has no `AmbientGlow`, so it sits at the
zone ambient while the converted world sits at ambient + glow. Give it the same `AmbientGlow` the
converted meshes carry and it matches. `AmbientGlow` only ever brightens (0..254; 255 means pulsing)
- to go the other way use `ScaleGlow`, a float multiplier on the actor's draw that KF's own
`KFDoorMover` ships at 0.5.

---

## 5. Rendering behaviour observed in the client

### 5.1 `PF_Invisible` on a BSP surface does not hide it — it draws it flat white
To keep a BSP as a level skeleton without drawing it, point every surface at a fully masked-out
texture instead (an 8×8 image whose every texel is the transparent palette index).

### 5.3 Textures must be power-of-two
Non-POT textures load but render wrong. Resample and scale the texture axes so the 0..1 UV maths
still lines up.

### 5.4 Static meshes render black unless the actor is marked `bUnlit`
Once they draw at all (see 5.4z), they come out black: nothing lights them, and the per-vertex
colours in `UStaticMeshInstance` are not applied on their own. `bUnlit=True` on the actor renders
them at full texture brightness, which is what the mesh route uses today. Carrying the baked
GoldSrc light onto the meshes is still unsolved.

---

### 5.4z SOLVED: actors are reached through the BSP, so a bad tree hides every static mesh
Root cause of "static meshes never draw", and of three other symptoms that looked unrelated. Two
fields decide it, and the flat tree had both wrong:

* **`iZone`** - `UModel::PointRegion` walks the tree and returns the `iZone` of the side whose child
  is INDEX_NONE. Leaving the back side at 0 (the solid/null zone) is correct in a real BSP, where
  behind a wall *is* solid; in the flat tree "behind a polygon's plane" means nothing, so most of
  the level answered "zone 0". Actors are drawn per visible zone, so none were drawn.
  Fix: `iZone = [1, 1]` on every node.
* **`iLeaf`** - left at INDEX_NONE everywhere, so an actor's region resolved to no leaf at all.
  Fix: one leaf, and `iLeaf = [0, 0]` on every node.

The same two fields explain: "Couldn't spawn player of type KFmod.KFHumanPawn" (gone after the
fix), KFEd's Map Check reporting "Navigation point imbedded in level geometry" for every
PlayerStart, and KFEd drawing the meshes as wireframe in its textured viewport.

`Model.Lights` is a pool of concatenated None-terminated light lists, indexed by a leaf's
`iPermeating` / `iVolumetric`. Pointing a leaf at index 0 of an *empty* Lights array is a read off
the end - write the lights followed by a bare `None` terminator.

### 5.4a What the static meshes are NOT
The meshes are rejected by the engine's *solid* draw path only. Ruled out by experiment, each
tested against the running game:

* mesh content - `killingfloor-map-viewer` (an independent reader) renders the converted meshes
  with full textures and correct layout, so the vertex/index/UV/material data is valid;
* section layout - stock meshes have `Materials.Num() == Sections.Num()` with the section's leading
  INT always 0, exactly as emitted here;
* texture format - switching every texture from P8 to DXT3 changes nothing (it is the default now
  anyway, since all shipped static-mesh content is block-compressed);
* object flags - matching the stock `RF_Public|RF_Standalone|LoadFor*` on textures and meshes
  changes nothing;
* the `TLazyArray` skip offset - ours is absolute and lands 10 bytes before the export's end,
  byte for byte the same rule the shipped meshes follow.

KFEd shows the same symptom from the other side: the meshes appear in every orthographic viewport
and in the textured 3D viewport, but always as wireframe.

Round-trip comparisons of a shipped mesh must be given the real export offset. The `TLazyArray`
skip offset is absolute, so re-serializing at base 0 always "fails" 24 KB in - an artefact of the
test, not a writer bug.

### 5.5 The flat-tree BSP has no solid leaves, so it has no world collision
The tree the converter builds carries *surfaces*, not solidity: one root plane with every polygon
pushed down into it, `iLeaf = -1` everywhere. The engine happily renders it and just as happily
lets the pawn fall straight through. Symptom in game: the map draws for a second, then the camera
is under the world looking up (sky white above, floor black below, because the floor is being seen
from its back face) and KF ends the round as a squad wipe. Collision has to come from the static
meshes' kDOP instead.

### 5.6 The flat tree's `LeafHulls` are worse than nothing
`iCollisionBound` hulls derived from that tree kill the pawn outright. With `--no-hulls` the same
map is stable and the pawn stands on the meshes. The mesh routes force it off.

### 5.7b Sky brushes must be CUT OUT of the meshes, not converted
CONFIRMED in game. A GoldSrc sky brush is textured with the 16x16 `sky` placeholder from
halflife.wad. Convert it like any other face and it becomes a pale lid sealing the level, hiding
whatever sky is put behind it - which is why "the sky is white" survived every fix aimed at the
sky itself (real gfx/env images, neutral lightmap, cube winding, two-sided cube). Drop every face
whose texture classifies as `sky` from the mesh build; the holes they leave ARE the view onto the
skybox cube. cs_assault: 295 faces cut.

Corollary: the skybox cube is built separately and does not pass through the world meshes'
winding flip, so it must not be "corrected" along with them. It is emitted with both windings so
the convention cannot silently break it again.

Second corollary, and it cost an evening: **cut the faces out only when a cube will be built.** A
map can name a sky whose `gfx/env` images are on nobody's disk - ka_legoland names `dustbowl`, which
ships with Counter-Strike and with none of the map packs - and then the holes have nothing behind
them. An unfilled hole is not "no sky": it is the previous frame smeared across the screen, bands of
yellow and magenta that read as a corrupt texture rather than as missing geometry.

So the missing-images case now builds the cube anyway, out of a flat blue 8x8 the converter
generates itself. Generated rather than named out of a KF package on purpose: a texture reference
the client cannot resolve is a map that will not open at all, and that is a far worse failure than a
plain sky. A stock KF sky was tried against it - `Waterworks_T.General.skyblue` renders as flat
blue, the same picture the generated one gives, for the price of a package dependency.

`--no-sky` is the one route with no cube at all, and there `hasSkybox` keeps the pale lid so the
level is sealed rather than smeared.

Better than either: point the converter at the images - `--wad <any cstrike folder that has
gfx/env>` plus `--sky <a name that is there>`, or `--cs-dir <a Counter-Strike install>` so the stock
skies are always found. The log says which it took: `skybox: desert (256x256 x6)` against
`skybox MISSING: dustbowl ... a flat sky stands in`.

### 5.8 RETRACTED: "a token BSP / chunked meshes stop the meshes drawing"
Both of those conclusions were false negatives from a broken test harness: the engine writes 24-bit
BMPs with no row padding, GDI+ refuses to open them, and the capture script silently reported a
blank frame. With the screenshots read correctly, a 1-node BSP and 351 grid chunks both render.
Do not trust a negative render result unless the screenshot pipeline itself has been verified.

### 5.9 SOLVED: hiding a BSP surface means keeping it out of the render sections
The BSP draws from its render-sections, which are built from every node with NumVertices >= 3.
Masking the texture, setting PF_Invisible, or zeroing NumVertices *after* the sections are built
all leave the surface in a section, and it draws flat white over the meshes. Zero NumVertices on
the hidden nodes BEFORE the section pass and the surface never enters one.

### 5.10 A static mesh is authored in LOCAL space; the actor carries the position
Emitting world-space vertices under an actor at Location (0,0,0) makes the engine cull with a
sphere centred on the world origin with the mesh RADIUS - so any chunk whose geometry sits away
from the origin is culled from most viewpoints. Re-centre each mesh on its own bounding box and
put the actor at that centre. (This is correct regardless; it was not what caused the missing
ground - see games/goldsrc.md 5.7a - but both had the same symptom.)

### 5.11 Subdividing for baked light is pure cost when the meshes are unlit
The converter split every face until its edges were under ~96 UU so per-vertex GoldSrc light had
somewhere to live. The meshes are drawn bUnlit, which ignores that light entirely, so the split
bought nothing and cost 10x the triangles and 10x the kDOP - it was the main source of the
in-game slowdown (82448 triangles -> 8141, and 8.9 MB -> 0.88 MB of batched vertex data).

### 5.12 The engine walks the BSP every frame; on the mesh route give it one node
With the meshes drawing the world and their kDOP carrying collision, the only thing still asked of
the world model is PointRegion. A single node far below the level answers that as well as 3570 do,
and the flat tree is not free - there is no PVS to prune it.

### 5.13 Light the meshes through the zone, not with bUnlit
`UStaticMeshInstance`'s per-vertex colours are NOT applied by the engine at run time - a mesh with
a correct instance still renders black - and a handful of converted `Light` actors do not reach
level-sized geometry either. Two ways out:

* `bUnlit=True` on the actor: full texture brightness, flat, and it also kills dynamic light, so
  the torch and muzzle flashes stop affecting the world.
* `ZoneInfo.AmbientBrightness`: lights the meshes through the zone and leaves dynamic light
  working. This is what the converter uses.

Pick the value from the map itself rather than a constant: the average GoldSrc luxel of the level
(cs_assault 63, de_dust2 84, cs_italy 78). A fixed 140 was visibly blown out.

Solved since, and not by a build: §4.11 carries the luxels across as an atlas texture and multiplies
the wall by them, with the actor still lit through the zone exactly as above. The baked light is
then part of the surface the engine lights, which is what keeps the torch and the muzzle flash
working - and it is why the ambient in that route is a fixed 40 for every map instead of a
per-map average.

### 5.17 WRONG DIAGNOSIS: "a skybox cube bigger than the far plane leaves white smears" (see 2.12)
The original claim: sizing the cube at 3x the level put its far corner 42000-55000 units out, past
the far plane, and the clipped part showed backbuffer KF never clears - white smears that come and
go as the view turns. The cube was shrunk to `clamp(radius * 1.35, 3000, 11000)`; the smears were
still reported afterwards, so shrinking was not the fix and the far plane was not the cause.

Measured since, on a2k_aimskillz: half-size **32000** (far corner ~55000) draws everywhere,
including straight up. Nothing was clipped. The real cause is the double winding - see games/goldsrc.md 5.25.

### 5.17a A real cube has parallax; that is what makes a close skybox look wrong
Counter-Strike draws its skybox around the camera, so the mountains never move. A cube built as
world geometry does move: at 1.35x the level radius the mountains sat at wall height directly
behind the walls, and walking across the map swung them visibly.

Push it out until the walk barely turns the sky - `clamp(radius * 6, 12000, 30000)` puts the swing
under 10 degrees end to end - and cap at 30000 (see 5.17: 32000 measured clean, 30000 keeps a
margin). The proper UE2 answer is `PF_FakeBackdrop` plus a `SkyZoneInfo`, which has no parallax at
all, but that flag lives on BSP surfaces and this converter's world is static meshes.

### 5.27 A Volume with no Brush model does NOTHING
A `PhysicsVolume` is an `ABrush`. Give it `CollisionRadius`/`CollisionHeight` and no `Brush`, and it
loads, sits in the level, replicates - and never touches anything. Proof: a build with the volumes
removed rendered pixel for pixel identically.

A working volume needs a `UModel` with a real BSP, not just Polys. The 71-byte 0-node models in the
shipped maps are the red builder brush; a `BlockingVolume`'s model carries 6 nodes, 6 surfs, 8
points, `rootOutside = 1`, and a leaf hull - 6 node indices, a -1, then the bbox as six floats - that
the last node points at through `iCollisionBound`. `unreal/polys.js` reproduces exactly that: six
outward planes chained down `iBack`, `iZone = [0,0]`, `iLeaf = [-1,-1]`.

Once it is real, the proof that it works is drowning: health falls and the volume's fog appears.

### 5.28 UPolys is UE1's layout, and the count comes first
`cidx NumVertices, FVector Base, Normal, TextureU, TextureV, FVector Vertices[N], DWORD PolyFlags,
cidx Actor, cidx Texture, cidx ItemName, cidx iLink, cidx iBrushPoly, SWORD PanU, SWORD PanV`.

The vertex count sits BEFORE `Base`, which is the part that looks wrong and costs an afternoon.
Confirmed byte-exact on 37k polys across the shipped maps; `test/selfcheck.js` keeps it honest.

### 5.32 "Largest Model wins" stops finding the world model
`findWorldModel` picked the biggest `Model` export. That is right for a shipped map, but this
converter's world model is deliberately one node - so the first water volume's box brush outgrew it
and `--verify` started checking a Volume against the world's invariants (12 bad indices, 0 leaves).
Match the name first.

### 5.33 A TRUNCATED MIP CHAIN (a real defect, but not the white flashes - those were 2.12)
The artefact, once and for all: for a frame the whole world draws pure white, with a scattering of
saturated cyan/magenta/yellow pixels tracing the polygon edges. The weapon and the HUD are normal,
so it is the world render, not an overlay. It moves with the view and comes back at random.

Two earlier diagnoses were wrong and are kept above as 5.17 (far plane) and 5.25 (the sky's double
winding - a real bug, and it did produce a white sky, but not this).

The cause: `addTexture` dropped every mip level smaller than 4x4, on the reasoning that "DXT works
on 4x4 blocks". `USize`/`VSize`/`UBits`/`VBits` still declare the full size, and the engine derives
the level count from those - `log2(max(U,V)) + 1` - not from the array it was given. So for a
256x256 texture it asks for levels 7 and 8 of an array with 7 entries, reads past the end, and
samples whatever memory is there. That memory is mostly 0xFF, which decodes to white; the coloured
specks are the few real bytes that leaked in.

Everything about the symptom follows from that:
* every world texture at once, because every one of them was short;
* only sometimes, because the two smallest mips are only selected at a distance or across a very
  shallow angle - which is exactly what looking up across a map does;
* on every converted map, and on no shipped one (KF-Crash: 1024x1024 with all 11 levels);
* saturated primaries rather than a tint - raw bytes, not arithmetic. That is what rules out the
  other candidate, "texture times an enormous light": multiplying a dark navy (30,40,90) can reach
  white but can never reach cyan, because R starts at 30 and only grows.

A level below 4x4 is still stored, as one block whose 4x4 is filled by repeating the tiny image;
the stored width/height stay the true mip size. `--verify` now fails any texture whose chain is
short, so this cannot come back silently.

**The general rule:** a size field and an array length are two separate claims, and the engine
believes the size field.

### 5.34 A KF door is a KFDoorMover AND its KFUseTrigger
`Engine.Mover` opens on a bump; a Killing Floor door opens with the use key and can be welded shut,
and that behaviour is in `KFMod.KFDoorMover`. It does nothing on its own: `PostBeginPlay` walks
`DynamicActors(class'KFUseTrigger')` looking for one whose `Event` equals the mover's `Tag`, and
takes `MaxWeld` from it. No trigger, no welding and no use key. So every converted `func_door` needs
two actors - the mover, tagged, and a `KFUseTrigger` at the same place with `Event` set to that tag
and a `CollisionRadius` big enough to stand in.

`KFDoorMover`'s own `InitialState` is already `TriggerToggle`, so do not set it, and do not set
`MoverEncroachType` either - its default is `ME_IgnoreWhenEncroach`, which is what stops a swinging
door from being blocked halfway by the player standing in it.

### 5.35 One material per mesh splits a door in half
The world is chunked one material per mesh, which is right for the world and wrong for an entity: a
CS door brush wears one texture on its two faces and another on its four edges, so it came out as
two meshes - two Movers at the same place, each holding half the door, and the door read as a
paper-thin sheet with no edges. Entity meshes stay whole and multi-section.

### 5.36 `bAlphaTexture` is an instruction, not a description
It does not mean "this texture has an alpha channel", it means "cut this surface out by it", and the
D3D renderer draws that as a dither pattern. Setting it from the format - DXT3/DXT5 have alpha, so
flag them - puts a stipple over every wall whose alpha the artist never used, which is most of them
in a Lineage 2 client. The importer classifies the alpha data instead (`docs/games/lineage2.md`
L2.11b) and only flags a texture the material is actually going to read.

The general shape of the fix: a surface's blending belongs to the MATERIAL, not to the texture.
Where the source says what it wants, carry the byte (`Shader.OutputBlending`); where it does not,
decide once, in one place, and give the texture a `Shader` that states the answer.

### 5.37 `UTexture` animates itself through `AnimNext`
`AnimNext` plus `MinFrameRate`/`MaxFrameRate` is a flipbook the engine runs on its own - no emitter,
no script, nothing per frame from the map. The last frame points back at the first. Any source
engine of the UE2 family stores the same three fields, so a fire or a waterfall comes across as an
animation rather than a still by carrying the ring of textures and their frame rate.

Writing a ring means an export has to reference one that does not exist yet, so the reference is
resolved at serialise time rather than when the export is registered.

## 6. LevelInfo / gameplay

### 6.0a "Navigation point imbedded in level geometry" means the BSP, not the spawn height
KFEd's Map Check reports it for *every* PlayerStart, together with "PlayerStart is not useable".
The points are not actually buried - the independent viewer draws them sitting on the ground - the
flat-tree BSP simply reads as solid everywhere, and the same check inside `ULevel::SpawnActor`
is what makes KF fail to place the pawn and end the round instantly. Raising the spawns does not
help; removing the flat BSP from the level does.

### 6.1 `LevelInfo.KillZ` defaults to 0
Anything spawning below the origin dies instantly. GoldSrc maps sit below z = 0 as often as not, so
the converter writes `KillZ = (lowest geometry) − 2000`.

### 6.2 A KF map with no `ZombieVolume` ends itself
`KFGameType` finishes the four waves in about 15 seconds and calls `ProcessServerTravel` to the next
map in the list. Any test harness must sample before that.

### 6.3 `?QuickStart=1` skips the lobby
Without it the client sits on the ready-up screen and *nothing after that point has been tested* —
including several "no Critical in the log" results that turned out to be meaningless.

---

### 4.12 KFEd crashes importing a static mesh over 20000 polygons
Reported by a mapper, and the reason big CS maps have to be brought over in pieces rather than as
one object. The 16-bit IndexStream would allow 21845 triangles, so the format is not the limit -
the editor is. The converter caps a mesh at 19000 triangles; with per-cell, per-material chunking
the real numbers are far below it (de_winter_austria, 14298 faces / 35995 triangles: 452 meshes,
largest 1985 triangles).

### 5.15 The sky reads about 2.5x brighter than its own texture
An unlit surface in KF is drawn at roughly 2.5x the texture value (UE2's overbright, plus KF's
bloom). Measured on cs_assault: the sky patch on screen was 233,233,249 where city1up's own mean
is 94,93,113 - a ratio of 2.48/2.50/2.20. Pre-divide the sky images by ~2.4 on the way in, or the
overcast grey of Counter-Strike arrives as a white glare.

Do not measure this from a screenshot taken with mouse-look: the pitch is not reproducible, and a
frame that happens to catch the bright part of the up face reads higher than the one before it.

## 7. Test-harness gotchas (Windows / KF client)

How to look at a converted map without a human at the keyboard. Several wrong conclusions in this
file came from a harness that lied, not from the converter - so this section is load-bearing.

### 7.0 THE RULE: a negative render result is worthless until the harness itself is proven
"The meshes do not draw" was concluded three times from a pipeline that was silently producing
blank images, and each time it sent the work down a wrong path (see 5.8). Before believing that
something does not render, shoot a case that is KNOWN to render - a stock KF map, or the same map
one change earlier - through the exact same pipeline.

### 7.1 Take the screenshot with the ENGINE, not off the desktop
`SetForegroundWindow` + `Graphics.CopyFromScreen` captures whatever Windows has on top, and the
foreground lock means that is often not the game. The engine has its own: `User.ini` binds
`F9=shot`, and the file lands in `<SDK>\Screenshots\ShotNNNNN.bmp`.

### 7.2 Those BMPs are 24-bit with NO row padding, and GDI+ refuses to open them
`[System.Drawing.Bitmap]::FromFile` throws "invalid input", which in a script reads as "the frame
was blank" - exactly the false negative behind 7.0. Rows are `width * 3` bytes with no 4-byte
alignment, so a reader must detect it:

```js
const padded = Math.ceil(width * bytes / 4) * 4;
const stride = (file.length - dataOffset) >= padded * height ? padded : width * bytes;
```

`harness/bmp2png.js` reads the BMP that way and writes the PNG with Node's own zlib - no
dependency, no GDI+.

### 7.3 Drive the client with PostMessage, not synthetic global input
`WM_KEYDOWN` / `WM_KEYUP` / `WM_CHAR` posted to the game window work without focus and without
stealing the mouse. Keys worth knowing: `0xC0` VK_OEM_3 toggles the console (`User.ini`:
`Tilde=ConsoleToggle` - Tab is NOT bound), `0x0D` Enter, `0x78` F9 shot, `0x27` turn right,
`0x57` W. Toggle the console shut again or it swallows the F9. Cheats need `EnableCheats` first;
`behindview 1` is the fastest way to see the ground and the player at once.

### 7.4 Skip the lobby, or the test proves nothing
Launched plainly the client sits on the ready-up screen and draws no level, so "no Critical in the
log" means nothing. Use `<Map>.rom?Game=KFmod.KFGameType?QuickStart=1`. It is NOT the path a
player takes (lobby -> Ready), so a bug can reproduce for them and not here.

### 7.5 A map with no ZombieVolume ends itself in ~15 seconds
`KFGameType` runs out of waves and calls `ProcessServerTravel`, so a late screenshot quietly
captures a DIFFERENT level. Sample within ~10 s and confirm from the log which level was brought
up.

### 7.6 Close politely, and free the file before rebuilding
`Stop-Process -Force` leaves `KillingFloor.log` unflushed - `CloseMainWindow()` first. A client
still holding the .rom makes the next build die with `EBUSY: resource busy or locked`.

### 7.7 Judge the picture, not the absence of a crash
The engine exits cleanly on a black frame, on a squad wipe, and after travelling to another map.
Print the mean luminance beside each shot: ~3 is a black screen, ~100-150 is a lit level. That
number cannot tell a correct level from a blown-out one, so still look at the image.

### 7.8 PowerShell 5 chokes on non-ASCII inside a .ps1
An em dash in a script run via `powershell -File` gives `Unexpected token` parse errors. Keep
harness scripts ASCII-only.

### 7.9 `-EXEC=<file>` runs console commands too early
It fires at engine init, before there is a pawn, so the screenshot it takes is of a black frame.

### 7.10 KFEd cannot be automated - and killing it corrupts its config
The editor starts but will not open a map from the command line, so editor checks need a human:
ask, and say which map and what to look for. Its viewport render mode is part of its own saved
state (a viewport labelled "Texture Use" draws wireframe by design), so "it looks wrong" may be a
mode, not the map. Killing KFEd with `Stop-Process` corrupts `unrealed.ini`; the symptom is a
white viewport on EVERY map including stock ones, and the fix is to restore it from
`DefUnrealEd.ini`.

### 7.10a READ THE LOGS FIRST - `System/Editor.log` and `System/KillingFloor.log`
Both the editor and the game write a running log next to the executable, and both say plainly what
a screenshot can only hint at. Check them BEFORE theorising about a symptom, and check them again
after every attempt:

- `System/Editor.log` - every KFEd command and what it did. `Cmd: MAP LOAD FILE=...` marks a map
  being opened, `Cmd: MAP REBUILD` / `Cmd: BSP REBUILD` a Build Geometry, `Cmd: LIGHT APPLY` a
  lighting build, `Cmd: PATHS DEFINE` a paths build. The lines that matter for a converted map:
  `BspValidateBrush linked N of M polys` (the BUILDER brush, Actors(1) - `0 of 0` means it ships
  empty, which no shipped map does) and `bspBuild built N convex polys into M nodes` (what the
  rebuild actually composed - `0 convex polys into 0 nodes` means not one brush qualified). A
  working map on the same install reads `bspBuild built 402 convex polys into 504 nodes`, so the
  number is also the proof that Build works at all here (7.0).
- `System/KillingFloor.log` - the same for the game; `Critical:` lines are what `test/render-test.ps1`
  rules on.

The log is rewritten per session, so read it right after the run that is being diagnosed. Three
rounds of guessing at brush fields were spent before this file was opened; it answered in one line.

### 7.10b KFEd overwrites the map you are testing, and the log does not always say so
A Build that fails leaves the level broken IN MEMORY; saving then writes that over the `.rom`. On a
converted map the tell is the world model collapsing to 72 bytes - `0 nodes, 0 surfs, 0 zones,
0 leaves` - while every `--verify` invariant still passes, because an empty model violates none of
them. The file also shrinks (13.42 MB -> 13.28 MB on cs_assault).

`Editor.log` is rewritten per launch, so a save from an earlier KFEd session leaves no trace at all:
two maps had been silently replaced this way and several rounds of "still broken after your fix"
were measured against a file the editor had already mangled.

Before reading anything into an editor result, check the map on disk is still the converter's:

    node -e "const R=require('./src/unreal/read');const p=R.load(F);
             const m=R.readModel(p,R.findWorldModel(p));console.log(m.nodes.length)"

and rebuild it if not. Tell the user to save experiments under a NEW name, never over the map.

### 7.10c What KFEd's Build Geometry actually does, decompiled
Guessing at this cost days. The code is in `System/Editor.dll` and `System/Engine.dll` and can be
read directly - `pefile` + `capstone` are enough, and the log format strings are the anchors that
locate the functions ("Rebuilding geometry", "bspBuild built %i convex polys into %i nodes").

Build Geometry issues `Cmd: MAP REBUILD`. Its handler (Editor.dll `0x1024e240` at the shipped image
base) resets the transaction buffer with "rebuilding map", clears a bit on the LevelInfo, calls
`AActor::ClearRenderData` on every actor, then `UEditorEngine::csgRebuild(Level)` (`0x10231620`):

    GWarn->BeginSlowTask("Rebuilding geometry")
    Level->Model->EmptyModel(1,1)
    for( actor : TStaticBrushIterator(Level) )          // 0x10230550
        if( bOnlyVisible && actor->IsHiddenEd() ) continue
        if( actor == Level->Brush() ) continue          // Level->Brush() IS Actors(1)
        if( (PolyFlags & PF_Semisolid) && CsgOper==CSG_Add && !(PolyFlags & 0x4000000) ) continue
        bspBrushCSG( actor, Level->Model, PolyFlags, CsgOper, 0, 1, 1 )

The iterator yields only actors that pass `AActor::IsStaticBrush()` (Engine.dll `0x103250e0`):

    Brush != NULL  &&  IsABrush()  &&  bStatic  &&  !IsAVolume()

`Brush` is the UModel at actor offset `+0x25C`; `bStatic` is bit `0x200` of the first bool word at
`+0x6C` (the tenth bool declared in `Actor.uc`). The virtuals are vtable `+0x1A4` = `ABrush::IsABrush`
and `+0x1AC` = `AActor::IsAVolume`, read out of `??_7ABrush@@6B@`.

`bOnlyVisible` is `GRebuildTools.GetCurrent()->[+0x10] & 0x10`, which comes from `unrealed.ini`
`[Rebuild Configs] Config0=Default,15,2,79,70,7`; the FString name occupies the first 12 bytes, so
`+0x10` is the SECOND number and the bit is clear - the visibility gate is off by default.

`bspBrushCSG` (`0x1022c4d0`) returns immediately when the brush's `Brush` model is NULL, before it
logs anything.

Reading the code was not enough on its own - every field it tests looked correct in our `.rom`. What
settled it was watching the running editor:

- `DebugActiveProcess` is refused on this machine (ERROR_INVALID_PARAMETER), so the editor was read
  with `OpenProcess` + `ReadProcessMemory` instead. `?GEditor@@3PAVUEditorEngine@@A` is exported by
  `Editor.dll`; from it, `GEditor+0x114` is the `ULevel`, `Level+0x30/0x34` the actor array,
  `Level+0x90` the world model. An actor is an `ABrush` when its vtable equals `??_7ABrush@@6B@`.
- Call counts came from detours: allocate RWX memory in the target, write `inc [counter]` plus the
  original prologue bytes plus a jump back, and patch the function's first bytes to jump there.
  Take the prologue length from a disassembler - counting bytes by eye cut `mov eax,[esi+0x25c]` in
  half and took KFEd down with a GPF.
- The numbers: `IsStaticBrush` 2258 calls, `bspBrushCSG` **1** call on our map and 9 on the
  hand-built port. The brush was never being skipped; the CSG simply had nothing to cut. See 2.8.

`UModel` in memory, useful for this kind of check: `+0x58` `Polys*`, then TTransArrays of 16 bytes
(Data, Num, Max, Owner-is-the-model) - `+0x5C` Nodes, `+0x6C` Verts, `+0x7C` Vectors, `+0x8C`
Points, `+0x9C` Surfs - and `+0x10C` RootOutside.

### 7.11 The harness is beside the converter, not inside it
`harness/play.ps1` (launch, drive, shoot, convert, report), `harness/bmp2png.js` (BMP reader + PNG
writer) and `harness/flat.js` (the edge-density judge). They are test tooling, not part of the
converter, and nothing under `src/` may depend on them - but re-deriving them costs an hour, so they
are versioned. `KF_SDK_DIR` points them at the game; `KF_SHOTS_DIR` overrides where frames land
(default `harness/shots/`).

### 7.12 `KF_SPAWN_AT="x,y,z"` puts the player where the thing to look at is
Checking water, a sprite or one corner of the sky means getting there, and the harness cannot walk
the map. The converter honours `KF_SPAWN_AT` (Unreal units, after the Y mirror) by replacing every
PlayerStart with one at that point. The converter logs where the interesting things are - water
volumes print their centres - so the two line up directly.

Falling into water this way is also the only proof that `bWaterVolume` took: the screen picks up
KF's underwater tint the moment the pawn is inside the volume.

### 7.13 How to reproduce the frames where the world does not render
The artefact: the whole world disappears for as long as the view is held a certain way. The weapon,
the HUD and the first-person effects keep drawing, so the screen is the zone's clear colour with a
gun on it. It is on every converted map and on no shipped one.

It is driven by **view direction** - not by position, not by time, and not by walking. That is why
days of bursts from a standing player came back clean, and why bursts that pitched straight up came
back clean too.

**Before any of it: check the level is actually being played.** The game window appears long before
the map is up, and a -Wait that is a second short poisons the whole run - the shots come from the
loading fade or the lobby, every frame measures as empty, and the artefact reads as either always
present or never. Probe instead of guessing: take one frame, measure it, and only start driving
the view once it is a live first-person view with the HUD on it. play.ps1 does this in Wait-Ready
and aborts with "map never became playable" rather than producing a run full of false positives.

The recipe, from the player who could hit it at will:

1. Pitch the view up, but **not** all the way - stop about 30 degrees short of vertical, so the
   camera is looking up diagonally.
2. Hold that pitch and **yaw slowly through a full circle**.
3. Somewhere in the sweep the world drops out. It is not one fixed angle: it has to be swept for,
   and it stays gone while the view stays there.

For the harness that means pitching part-way (`-PitchDy` around -500, not -2000), then stepping the
yaw in small increments with a shot after each - which is `-TurnDx` plus `-Fast`:

```powershell
.\play.ps1 -Map KF-CS-Assault -Wait 12 -Shots 30 -PitchDy -500 -TurnDx 220 -MaxW 500 -Fast
```

Judge the frames with `harness/flat.js`: it reports edge density over the left of the frame, away
from the weapon and the HUD. A normal frame is 18-30%, a dropped one about 1.4%. Do NOT judge by
mean luminance - a dark wall in the face reads the same as the artefact, and the loading fade
reads 0.0.

**The rule this is an instance of:** when a bug will not reproduce, the harness is missing something
the player does. Ask exactly what their hands are doing and take the answer literally - "look up"
and "look up to 30 degrees short of vertical, then turn" are different tests, and only one of them
finds it.

