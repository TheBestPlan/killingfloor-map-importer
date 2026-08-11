# GOTCHAS — Killing Floor Map Importer

Everything that cost time while writing a Counter-Strike 1.6 `.bsp` → Killing Floor `.rom`
converter, written down so it does not have to be rediscovered. Each entry is a fact that was
*measured* against the shipped game files or observed in the running client, not a guess.

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
Reported by a mapper, and it has two separate consequences - both bad, both silent:

* at load, the engine walks KInitActorKarma -> KCreateActorGeometry -> KAggregateGeomInstance for
  every actor using the mesh and allocates until the process dies of "Ran out of virtual memory";
* in play, corpses of players and monsters FALL THROUGH the floor instead of resting on it, because
  ragdolls collide against the simplified karma hull rather than the real surface.

The converter emits it False on every mesh it makes (unreal/staticmesh.js). Do not "tidy it away" -
nothing in the file says why it is there, and the second symptom appears only minutes into a match.

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
* **The luxels go in at 1.0 against a zone ambient of 40.** The ambient is a plain multiplier on the
  atlas now, so it is the SAME for every map - what varies from map to map is already in the atlas,
  and a per-map ambient would count it twice. Measured on cs_assault against 1.7 and 2.5, which blew
  the lit half of the level out.
* The unlit route keeps its own number, 0.55: an unlit surface reads about 4x its material, so
  `255 / (128 * 4)` lands on the same screen value - judged against Counter-Strike side by side on
  gg_trs_aim_churches, where 0.8 still washed the wall out. The app's light multiplier scales
  whichever is in use, so a whole level dims or lifts from one field.
* **The torch is a projector plus a light** (`Effect_TacLightProjector` + `Effect_TacLightGlow`).
  The projector draws its own spot on any surface and never depended on this; the light has
  `LightRadius=3` and fades with beam length, so it only shows close up.

---

## 5. Rendering behaviour observed in the client

### 5.1 `PF_Invisible` on a BSP surface does not hide it — it draws it flat white
To keep a BSP as a level skeleton without drawing it, point every surface at a fully masked-out
texture instead (an 8×8 image whose every texel is the transparent palette index).

### 5.2 GoldSrc masks on palette index 255, Unreal on index 0
Swapping the two indices *and* the two palette entries preserves every other colour exactly.

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

### 5.6a A flat lightmap of 255 is double brightness, not "fully lit"
Faces with no GoldSrc lighting get a synthesised flat block. Filling it with 255 blows the surface
out to solid white; 128 is the neutral value. This is what made the converted sky read as a white
wall even after the real skybox images were mapped onto it.

### 5.7 GoldSrc sky is not in the .bsp
Sky brushes are textured with a 16x16 placeholder named `sky` that lives in `halflife.wad`. The real
sky is six images under `gfx/env/<skyname>{up,dn,lf,rt,ft,bk}`, named by `worldspawn`'s `skyname`
(`city1` for cs_assault). Converting the placeholder as an ordinary texture stretches a nearly flat
pale image over 295 faces, which reads as a blown-out white wall and hides everything behind it.

### 5.7a SOLVED: the Y mirror reverses triangle winding, so every face was culled
GoldSrc is right-handed and Unreal is left-handed, so the converter mirrors Y. A mirror also flips
the orientation a rasteriser sees: emitting a face ring in its original order presents its BACK to
the camera, and back-face culling deletes it. Emit [v0, v2, v1] instead.

Why it was so hard to spot: it does not blank the level. You still see plenty of geometry - the far
side of the street, walls of buildings across from you - because those are back faces of surfaces
whose fronts point away. What disappears is whatever you are meant to be looking at from its front:
above all the ground under your feet, which then shows the skybox through it. It reads as "some
textures/meshes are missing", not as "the winding is inverted".

A check that will NOT catch it: comparing the Newell normal of the emitted triangle against the
stored surface normal. Both are computed in the same mirrored space, so they agree perfectly (0 of
2382 faces "wrong") while every one of them is still backwards on screen. Test it in the running
game, by looking at a surface whose front you know - the floor.

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
ground - see 5.7a - but both had the same symptom.)

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

### 5.7c Do not hand-write the skybox face orientation - solve it from the images
Which way each of the six sky images has to be rotated is a convention, and it was got wrong
twice: once from a half-remembered Quake `st_to_vec` table (which put all four side faces on the
SAME plane - there was no cube at all), once from hand-reasoned axes (a cube, but with the
pictures rotated against each other). The failure is quiet: the sky is there, it just breaks
across the cube edges.

Solve it instead of guessing. Neighbouring faces share an edge and a sky image is continuous
across it, so: try each face in its 8 orientations (4 rotations x optional mirror) and take the
combination whose border pixels agree. Pre-compute the cost of every (edge, orientation,
orientation) triple - 12 edges x 8 x 8 = 768 strip comparisons - and the 8^6 whole-cube
combinations are then table lookups, ~40 ms. Pin one face (a whole-cube rotation changes no seam)
so the answer is stable.

Greedy growth from an anchor face is NOT enough: it fixes a face before seeing the neighbour that
contradicts it. Measured mean seam error on cs_assault's `city1`: 120.9 unoriented, 73.6 greedy,
**32.5 exhaustive**. All three test skies (city1, des, green) independently resolve to the same
orientation set - `ft, bk:mirror, lf:mirror, rt:mirror, up:rot90:mirror, dn:rot270:mirror` -
which is the sign that a real convention was found rather than one picture fitted.

Seams also need the texture itself to cooperate: clamp (`UClampMode`/`VClampMode` = 1), NO mip
chain, and UVs pulled half a texel in from each edge. A lower mip averages across the whole face
and wrapping pulls in the opposite edge - both draw a bright line along every cube edge.

### 5.14 Ambient must come from the SHADOW level, and from every luxel
Two mistakes in a row here, both visible as "too bright":

* averaging - the mean is dragged up by direct light, so an open sunlit map blows out
  (cs_italy's luxels average 102 against cs_assault's 75, while their shadow level is the same 38);
* sampling at mesh VERTICES - they cluster on face edges and over-weight small bright faces.

Take the 25th percentile over every luxel of every lightmap. Values land close together across
very different maps, which is what an ambient term should do: cs_assault 40, de_dust2 46,
cs_italy 40.

### 5.17 WRONG DIAGNOSIS: "a skybox cube bigger than the far plane leaves white smears" (see 2.12)
The original claim: sizing the cube at 3x the level put its far corner 42000-55000 units out, past
the far plane, and the clipped part showed backbuffer KF never clears - white smears that come and
go as the view turns. The cube was shrunk to `clamp(radius * 1.35, 3000, 11000)`; the smears were
still reported afterwards, so shrinking was not the fix and the far plane was not the cause.

Measured since, on a2k_aimskillz: half-size **32000** (far corner ~55000) draws everywhere,
including straight up. Nothing was clipped. The real cause is the double winding - see 5.25.

### 5.17a A real cube has parallax; that is what makes a close skybox look wrong
Counter-Strike draws its skybox around the camera, so the mountains never move. A cube built as
world geometry does move: at 1.35x the level radius the mountains sat at wall height directly
behind the walls, and walking across the map swung them visibly.

Push it out until the walk barely turns the sky - `clamp(radius * 6, 12000, 30000)` puts the swing
under 10 degrees end to end - and cap at 30000 (see 5.17: 32000 measured clean, 30000 keeps a
margin). The proper UE2 answer is `PF_FakeBackdrop` plus a `SkyZoneInfo`, which has no parallax at
all, but that flag lives on BSP surfaces and this converter's world is static meshes.

### 5.17b No `skyname` does NOT mean no sky
`worldspawn` without a `skyname` key falls back to whatever `sv_skyname` holds, which ships as
`desert`. a2k_aimskillz is one of these: skipping the skybox when the key is absent left the map
with no sky at all. Default the name, then report MISSING only if the images are not found.

### 5.18 Masked textures need their hidden colour bled away, not just alpha
GoldSrc marks a cut-out with the last palette entry, which in nearly every CS texture is pure
blue. Setting alpha to 0 hides the texel but leaves its RGB blue, and both bilinear filtering and
every mip below the top blend that blue back in - the blue fringe around ladders, fences and
foliage. Replace the hidden texels' colour with the average of their visible neighbours (a few
passes so it reaches several texels deep) before encoding. Nothing blue is left to bleed.

### 5.19 Community maps expect the stock WADs to be installed
A downloaded map is usually just the .bsp, with `worldspawn.wad` naming halflife.wad, cstrike.wad,
de_aztec.wad and so on. Searching only next to the map makes every texture the magenta
placeholder, which reads as a broken converter rather than a missing file. Fall back to an
installed Counter-Strike (`KF_HALFLIFE` overrides the guesses).

### 5.20 Upscaling the sky: Lanczos-3, at convert time
A 256px sky face spread over 90 degrees is ~3 pixels per degree and reads as a blur. Upscaling
invents nothing, but it decides whether what is there arrives crisp: nearest is blocky, bilinear
is what the GPU already does (so it changes nothing), bicubic overshoots slightly, Lanczos-3 is
the sharpest separable filter. Do it separably - rows then columns - and 256 -> 1024 costs ~85 ms
per face, once. Normalise the weights per output pixel or flat areas drift and edges darken.

### 5.21 A texture name is NUL-terminated, and the junk after it can contain a newline
The 16-byte name field in a miptex (and in a WAD directory entry) is padded with whatever was in
memory. Cutting it with `/\0.*$/` looks right and is wrong: JavaScript's `.` does not match a
newline, so `"AzTrim\0.wal\nWal"` survives as a name that matches no WAD lump. One texture on
a2k_aimskillz came out as the magenta placeholder for exactly this. Use `/\0[\s\S]*$/`.

### 5.22 A GoldSrc water brush is a closed box - keep only its top
`func_water` is a solid brush: a top, a bottom and four sides, all wearing the same `!` texture.
Emitting all six as translucent planes stacks them into the smear that reads as "the water texture
is layered wrong", and the five that are not the top are buried in terrain anyway.

Keep the faces whose normal points up (`n.z >= 0.5`), drop the rest - a2k_aimskillz goes from 558
water faces to 140 - and set `bTwoSided` on the liquid texture, because a swimmer under a
one-sided plane looks up at open sky.

### 5.23 Swimming needs a `PhysicsVolume`, and one cylinder per pool is too wide
Translucent faces are a picture; the player falls through them. KF decides you are in water from a
`PhysicsVolume` with `bWaterVolume` - and a Volume with no Brush model does work, taking its shape
from `CollisionRadius`/`CollisionHeight` (verified in game: the underwater overlay appears).

Do NOT use the circumscribed circle of the brush. a2k_aimskillz' channel is 4378x1094 units, whose
enclosing circle has radius 2256 - it would make the dry ground for 2000 units around the pool
swim. Lay a row of INSCRIBED cylinders (radius = the short half-side) down the long axis instead:
never wider than the water, and the only water it misses is the four corners.

`Priority` must beat `DefaultPhysicsVolume`, and `FluidFriction` around 2.4 swims like CS.

### 5.23a Zeds cannot swim, so the water volume must not reach the bottom
`KFMonster.uc:4007` is `bCanSwim=False`. A zed that reaches a `bWaterVolume` has nowhere to path
to, stands in it, and drowns - watch `Bug_fy_evilpyramid.mp4`. Killing Floor ships no swimmable
water anywhere: every `PhysicsVolume` in the stock maps is a sound volume (KF-Farm has 25, all
`VolumeEffect=EFFECT_WOODEN_*`, not one with `bWaterVolume`).

Turning the water off is not the answer either - the player is supposed to swim. Lift the volume's
FLOOR instead: which volume an actor is in is decided by its Location, its centre, and every zed
stands 44 units up (crawler 25, boss 44), so 110 units of standing room under the water leaves them
walking normally while a player at the surface swims. A pool with less than ~48 units of water left
above that band keeps its full box and carries only the tint - and the tint is the other half of
what this actor does: it comes from `bNewKFColorCorrection` / `KFOverlayColor`
(`HudKillingFloor.uc:2294`), not from `bWaterVolume`. `--no-swim` drops the flag everywhere.

### 5.21a THE BLUE FRINGE: a cut-out texture's mip chain cannot be point-sampled
GoldSrc masks on the last palette entry, and in almost every CS texture that entry is pure blue.
Hiding it with alpha is not enough - the RGB under it is still blue, and every filter that mixes
texels drags it back onto what is visible. Measured on gg_33_mario's `{zaun01` fence, per level,
"colour under the transparent texels / colour of the visible ones":

    256x64  38,30,138 / 129,109,80      the top level, already blue underneath
    64x16   32,27,188 / 127,109,146     the visible texels are drifting blue too
    4x1     0,0,255   / 0,0,255         the whole level is the mask colour

That last level is what a fence across the field samples, which is exactly the "blue far away,
normal close up" report. Two causes, both needed:

* the chain was built by point-sampling PALETTE INDICES, so one unlucky texel turns a 2x2 into
  cut-out, and small levels end up entirely mask-coloured;
* `bleedTransparent` ran a fixed four passes - four texels - and a third of a fence is gap, so the
  middle of every gap kept its blue. DXT fits its block endpoints across all 16 texels, so the
  visible ones inherit it.

Build the chain for a masked texture in RGBA instead: average colour over the VISIBLE texels only,
keep alpha binary at half coverage, bleed to convergence, and hand a level that has no visible
texel left the average colour of the one above it. Same fence afterwards: `72,57,35 / 129,109,80`
at the top and `123,101,74` at 1x1 - no blue anywhere.

### 5.21b The sky was two thirds of the file, because RGBA8
Six faces at 512x512 RGBA8 with mips is 1.33 MB each - 8 MB of an 11.5 MB map, against 2 MB for all
the world geometry. A hand-built port ships the same sky at 1024 in DXT1 for 0.5 MB a face. Block
compression on a gradient is the thing RGBA8 was chosen to avoid, and resolution buys that back:
gg_dustwars went 11.52 MB -> 3.99 MB, smaller than the hand-built version of the same level.

DXT1 is DXT3 without the alpha half - the colour block is byte-identical - so the encoder is eight
bytes copied out of each sixteen. It cannot carry an alpha channel, so anything masked stays RGBA8.

### 5.22a The distance fog that fixes the flashes also washes the map blue-grey
`bClearToFogColor` is what stops the frame-to-frame accumulation; the fog RAMP is a side effect
nobody asked for. It is linear between `DistanceFogStart` and `DistanceFogEnd`, so at
`start -2000 / end 250000` a surface 25000 units away already carries a tenth of the fog colour -
enough to read as a blue-grey cast on distant geometry that clears as the player walks toward it,
and on the skybox cube at 30000 as well. Pushing the end to 2000000 takes the ramp out of the map -
and with the flashes traced to `iRenderBound` (2.12) rather than to frame accumulation, the whole
block is off by default now: `bDistanceFog`, `bClearToFogColor`, `bNewKFColorCorrection` and
`KFOverlayColor` only push a converted map away from the original it should match. `KF_FOG=1`
brings them back for anyone who wants the KF grade.

### 5.23b What makes a brush water is the ENTITY, not the texture
gg_33_mario's two pools are `func_water` wearing `weg01` - no `!` anywhere. Test only the texture
name and the water box goes through as ordinary geometry: both facings of all 54 faces are kept and
the pool z-fights into moving stripes across the whole surface (§5.26 is the filter that should
have caught it). Key the water rules on the classname and let the texture be an extra hint.

That brush is also 8 GoldSrc units thick - a water SHEET, not a filled pool. Depth cannot be
assumed from the fact that the entity exists.

### 5.24 Sprites: `Engine.Effects` is the billboard, and `.spr` is 40 bytes of header
`env_sprite`, `env_glow` and `cycler_sprite` name a `.spr` in their `model` key. `Engine.Effects`
is the right actor to place them with - `DT_Sprite`, `bUnlit`, no collision, no physics and no
script of its own. `Texture`, `Style`, `DrawScale` and `ScaleGlow` are the whole conversion.

The format: 40-byte header (`IDSP`, version 2, type, texFormat, radius, maxW, maxH, numFrames,
beamLength, syncType), then `uint16` palette size and the palette, then per frame `group, originX,
originY, width, height` and the indices. Only frame 0 is convertible - a static level cannot play
an animation. `texFormat` decides the alpha: 3 (ALPHTEST) makes index 255 transparent, 1
(ADDITIVE) uses luminance, and 2 (INDEXALPHA) takes the COLOUR from the last palette entry and
reads the index itself as the alpha ramp - that last one is how glows and coronas are stored, and
reading it as a normal paletted image gives a black square.

`DT_Sprite` draws the texture at `USize * DrawScale` units, so any resize to power-of-two has to
be divided back out of `DrawScale` or the sprite changes size. Resample the alpha channel too.

### 5.25 PARTIAL: the SKY was also drawn with both windings (the flashes were 2.12)
The artefact: the whole screen goes white as the view turns up, with faint dotted diagonal lines of
saturated cyan/magenta across it, coming and going as the view moves. Reported on every map, and it
survived every change to the size of the sky cube.

The cause is one line in `build/skyboxmesh.js`: the cube was emitted with BOTH windings, as
insurance against getting the convention wrong. Two exactly coplanar triangles per face z-fight, and
wherever the back-facing copy wins the depth test the pixel is culled - leaving a backbuffer KF
never clears. White, and moving with the view. The dotted lines are the triangle edges of the fight.

Measured: with only the wrong winding the entire sky is white with a black shape in it; with only
the right one it draws. Emit ONE winding. This was a real bug and worth fixing, but it was NOT the
white flashes the user kept reporting - those survived it. See 5.33 for the actual cause.

The general rule this is an instance of: **anything drawn twice at the same depth is not merely
ugly, it can be invisible** - two coplanar surfaces plus back-face culling is a hole in the frame.

### 5.26 A GoldSrc water brush stores every plane TWICE, and its floor points up
Water is drawn from inside as well, so the compiler emits each plane once per facing. Keeping the
up-facing copy is not enough: the box floor has an up-facing copy too, and it lands exactly on the
solid pool bottom underneath - two coplanar surfaces that z-fight into the horizontal stripes that
read as "layered water textures". a2k_aimskillz shows it down the whole channel.

Two filters, both needed: drop faces whose normal points down (the inward copies), and, for a brush
ENTITY, drop everything below the model's `maxs[2]` (the box floor). A `!` texture on a world brush
is a river surface with no box around it, so there the normal test alone is right.

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

### 5.29 Half-Life .mdl: two offsets decide whether it works at all
`studiohdr_t` has `numbones` at **140** and `boneindex` at 144 - not 148/152: `name[64]` starts at 8
and `length` sits at 72. `mstudiobone_t` is 112 bytes with `value[6]` at **+64**, after
`bonecontroller[6]`. Get either wrong and every vertex comes out NaN, which `JSON.stringify` prints
as `null` and a mesh writer serializes without complaint.

Vertices are in bone space: build the bind pose from `value[0..2]` (position) and `value[3..5]`
(X-Y-Z euler, radians), chain each bone onto its parent, and transform. Skip it and the prop
collapses onto the origin. Triangles arrive as strip/fan command lists (`SWORD count`, negative =
fan), and the textures may live in a companion `<name>T.mdl`.

### 5.30 What CS brush entities become
* `func_door` / `func_door_rotating` - an `Engine.Mover` with `DrawType = DT_StaticMesh` (7) and the
  door's own mesh. `KeyPos[1]` is the slide: direction from `angle` (-1 up, -2 down, else a yaw),
  distance = the brush's size along that axis minus `lip`. `KeyRot[1]` is the swing: `distance`
  degrees, sign from spawnflags bit 1. `BumpOpenTimed`, the default state, is what a CS door does.
  A rotating door turns about its `origin` brush, so put the actor there and let `PrePivot` carry the
  mesh back - an actor rotates about `Location` and draws at `Location - PrePivot`.
* `func_breakable` with `material` 0 or 7 - `KFMod.KFGlassMover`, which extends Actor rather than
  Brush and so takes a StaticMesh directly. `Health` from the entity; `Style = STY_Translucent` and
  `ScaleGlow` from `renderamt`, or the pane converts to an opaque slab.
* Everything else (`func_wall`, `func_illusionary`, `func_ladder`…) stays world geometry.

Both need their faces kept OUT of the world's chunks, and kept whole: chunking a door by the spatial
grid gives two halves that open independently.

### 5.30a Glass is a per-ENTITY alpha in GoldSrc and a MATERIAL in Unreal
A mapper makes glass by giving the brush entity `rendermode 2` and an alpha in `renderamt` -
aim_texture_maze has 36 `func_wall`s at `renderamt 110`. The texture itself is opaque, so a
converter that only carries textures across turns every window into a solid slab.

Unreal has no per-actor alpha for world geometry, and `PF_Translucent` on a surface is NOT the
answer: measured over the stock maps, **not one BSP surface in KF-Crash, KF-Farm, KF-Bedlam or
KF-Aperture carries it** (their flags are 0, `PF_Unlit`, `PF_FakeBackdrop`, `PF_Invisible|NotSolid|
TwoSided`, `PF_Semisolid`). What those maps do carry is materials: KF-Crash points 10 of its
surfaces at `Shader`s, KF-Aperture 2, KF-Bedlam at a `Combiner`.

So the texture gets a second material - `Engine.Shader` with `Diffuse` = the texture,
`Opacity` = an `Engine.ConstantColor` whose Color alpha is the entity's `renderamt`,
`OutputBlending = OB_Translucent` (3) and `TwoSided` - and only the faces of that entity use it.
One Shader per (texture, alpha) pair; `rendermode 5` is additive, so it takes `OB_Brighten` (5)
instead. `rendermode 4` is a colour-key cut-out, not translucency, and stays opaque.

Note `Engine.Texture` has NO `Style` property in this engine - the chain is
Texture -> BitmapMaterial -> RenderedMaterial -> Material and none of them declares one, so the
`Style = STY_Translucent` this converter writes on water textures is a no-op that the loader skips
by size. Water reads as water because of `bAlphaTexture` plus the alpha baked into its DXT3 blocks.
`Style` on an ACTOR (KFGlassMover) is real - that one is `Actor.Style`.

### 5.30b Every `func_breakable` is a separate object, whatever its material
`material` says what a breakable is made of - 0 glass, 1 wood, 2 metal, 4 cinderblock, 7
unbreakable glass - and it was read as "only glass is worth an actor". gg_33_shudder's six
cinderblock walls (material 4, health 10) are shot away in the original; merged into the world's
chunks they became terrain: indestructible in game, and impossible to delete in the editor without
tearing a hole where they met the geometry around them.

`KFMod.KFGlassMover` is the only KF actor that takes damage, hides itself and clears its collision,
so it carries the non-glass ones too - with `GlassBits` and `BreakGlassBits` set to None, or a
concrete wall showers the room in glass shards on the way out.

### 5.30c Half the KF hit emitters draw nothing, and `class<X>` is not an object property
Two separate reasons a broken wall blinked out with no debris at all:

* `RockHitEmitter` and `DirtHitEmitter` - the two whose names fit stone and rubble - carry
  `Texture=none//Texture'EmitterTextures.MultiFrame.rockchunks02' KFTODO: Replace this`. Tripwire
  commented the particle texture out, so they spawn and emit nothing visible. Whole ones:
  `WoodHitEmitter` (KFMaterials.WoodChips), `MetalHitEmitter` (KFX.KFSparkHead),
  `FleshHitEmitter`, the glass pair, and the door-explosion emitters `KFDoorExplosionDustWood` /
  `KFDoorExplosionDust` - which are also the right SIZE for something wall-sized breaking.
* `GlassBits` and `BreakGlassBits` are `class<Emitter>`, and a class property is tag type 8, not
  the object tag 5. The engine matches the tag against the property it is loading into and drops
  what does not agree - silently, with the class default left in place.

### 5.31 `.mdl` props are placed by cycler_sprite, not by any model entity
Counter-Strike has no env_model. Scenery models are `cycler_sprite` (also monster_furniture, cycler)
whose `model` names a `.mdl` instead of a `.spr` - de_winter_austria places 61 that way, including
the truck. Filter the sprite path on the extension or they all silently vanish.

### 5.31a A cycler_sprite draws its model a QUARTER TURN past the yaw it declares
The truck on de_winter_austria carries `angles "0 90 0"`, and reproducing that yaw put it across
the road instead of along it - its headlight glows, two `env_glow` sprites the mapper placed by
hand, ended up 90 degrees away from the headlights.

The mapper leaves a second record of the true orientation: the AAATRIGGER box he built around the
prop so the player cannot walk through it. That box is the model as the running game draws it, so
comparing its footprint with the model's own answers the question - modulo 180, which is exactly
the ambiguity in play. Measured with `scripts/propyaw.js`, on three models with different long
axes (truck 109x281, table 102x46, austbochki 42x84) at yaws of 0, +-90 and 180: **7 of 7 are drawn
a quarter turn past the declared yaw, 0 at the yaw itself**. A model authored the wrong way round
cannot explain that - the offset holds across models whose own long axis differs.

The remaining 180 comes from the truck's glows: its front is local +Y (the hood is the low section,
`maxZ` 49 against 120 over the cab and the tarp), the glows sit at world `(+-47, -130)` from the
origin at hood height, so local +Y must end up pointing at world -Y. Rendered yaw = declared + 90,
not declared - 90.

So the prop rotation is `-(yaw + 90)` in Unreal: the `+90` is the engine's, the negation is the Y
mirror (5.7a). Pitch stays a straight copy: a mirror across Y leaves a rotation about Y alone, and
the two remaining inversions cancel - GoldSrc's studio renderer flips pitch itself (`angles[PITCH]
= -angles[PITCH]`) and Unreal's pitch raises the nose where Quake's lowers it. Roll is left alone:
6 of the 1456 props in the corpus set one, and none of them sits next to anything that would
measure it.

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

## 6. LevelInfo / gameplay

### 6.0a "Navigation point imbedded in level geometry" means the BSP, not the spawn height
KFEd's Map Check reports it for *every* PlayerStart, together with "PlayerStart is not useable".
The points are not actually buried - the independent viewer draws them sitting on the ground - the
flat-tree BSP simply reads as solid everywhere, and the same check inside `ULevel::SpawnActor`
is what makes KF fail to place the pawn and end the round instantly. Raising the spawns does not
help; removing the flat BSP from the level does.

### 6.0 CS spawn points are at the player's centre, not on the floor
`info_player_start` sits ~36 GoldSrc units above the floor, which is ~90 Unreal units after the x2
scale. A KF pawn dropped from there does not reliably land - it sometimes falls through the mesh it
was supposed to land on. The converter now ray-casts down onto the GoldSrc faces and places the
`PlayerStart` 46 units above the floor.

### 6.0b A spawn point's `model` is Hammer's preview player, not a prop
`info_player_start` / `info_player_deathmatch` often carry
`model "models/player/gsg9/gsg9.mdl"` - it is how the editor draws a stand-in where the player will
appear, and GoldSrc never renders it. aim_texture_maze carries 24 of them, gg_toycarpark 34,
supercrazycars none. Import them with the rest of the `.mdl` props and the map gets a T-posing
terrorist standing on every spawn - with collision, right where the pawn has to materialise, so
KFEd's Map Check answers "PlayerStart is not useable" and the player can die the moment the round
starts. Filter spawn classnames out of the prop pass.

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

### 5.16 Which sky image goes on which face is Quake's layout, not the compass
`rt +X, lf -X, bk +Y, ft -Y, up +Z, dn -Z`. Laying them out by what the names suggest (ft +X, bk
-X, lf +Y, rt -Y) leaves a seam error that no rotation can remove, because a wrong face
assignment is not a rotation. Mean seam error over the 12 cube edges, each with its best rotation
set: city1 32.5 -> 21.0, des 42.8 -> 13.9, green 42.9 -> 6.4. With the layout right, the rotation
solver returns the clean answer `rt lf bk ft up:rot180 dn:rot180` - no mirrors on the sides.

### 5.16a A sky set in the wild can be INCOMPLETE, and "all six or nothing" costs the whole sky
gg_33_mario asks for `skyname toon`, and `toonrt.tga` does not exist - not in the map's own
`cstrike/gfx/env`, not in a full Counter-Strike install, only five files were ever shipped. A loader
that demands six returns nothing and the map ends up with no sky at all while the images sit right
where the user pointed it. Stand the absent sides in instead: a missing wall takes a mirrored copy
of a wall that exists, a missing `up`/`dn` takes the flat average of the row that meets it. Only an
empty set is a missing sky.

### 6.4 What else a CS map carries, and how it maps
* `light_environment` - the sun: a direction (`pitch`, `angles`) and a colour (`_light`), with no
  position. KF has no Sunlight class; `Engine.Light` with `LightEffect = LE_Sunlight` (19) and
  `bDirectional` does the same job, taking its direction from the actor's Rotation. GoldSrc pitch
  is negative pointing down and Unreal's is positive pointing up.
* `!`-prefixed textures and `func_water` - water. Bake `func_water`'s `renderamt` (~100/255) into
  the DXT3 alpha block and set `bAlphaTexture`, `bTwoSided`, `Style = STY_Translucent` (3). Keep
  the water triangles in their OWN meshes and clear collision on those actors: in CS you swim
  through water, so a water mesh with normal collision is an invisible wall across the pool. Top
  face only (5.22), plus a row of `PhysicsVolume`s so it can be swum in (5.23).
* `env_sprite` / `env_glow` / `cycler_sprite` - billboards (`model` names a `.spr`, plus `scale`,
  `rendermode`, `renderamt`). Converted as `Engine.Effects` actors; see 5.24.
* `infodecal` - wall decals; not converted.

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

