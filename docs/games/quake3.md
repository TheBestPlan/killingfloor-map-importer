# Quake III Arena / Team Arena

What reading a Quake 3 client costs, and what its own conventions do to a conversion. Every entry
was measured against the shipped game files or seen in the running Killing Floor client.

The engine these end up in — Killing Floor, Unreal Engine 2.5 — has its own notes in
[`../GOTCHAS.md`](../GOTCHAS.md); the other source games are in [`goldsrc.md`](goldsrc.md) and
[`lineage2.md`](lineage2.md).

Counted over both games' stock maps: **36 in `baseq3`** (32 id maps, three later tournament maps and
`test_bigbox`) and **23 in `missionpack`** (`mp*` plus `pro-q3tourney7` and `texturegrab`).

---

## Q3.1 A map is not a file — the client is the input

A `.bsp` on its own is geometry with the texture names left in it. Everything those names point at —
the wall images, the `.shader` scripts that say what a name means, the six sky faces — lives in the
client's `.pk3` archives, which are ordinary zips. So the converter takes a **client folder** and a
**map name**, the way the Lineage 2 route does, and reads the archives itself:

* the search path is the mod folder over `baseq3`, and inside a folder the archives are read in name
  order so a later pak overrides an earlier one — `pak8.pk3` wins over `pak0.pk3`;
* loose files beside the archives win over all of them, which is what an extracted texture is for;
* a loose `.bsp` still works (`--game q3 <map.bsp> --client <folder>`), but without a client every
  surface comes out as the magenta placeholder.

Team Arena is the same format in another folder: `--mod missionpack`. Its maps read `baseq3`
underneath them for the textures they share, which is why the mod folder alone is not enough.

**A GOG "Quake III Arena" install has no Team Arena content** unless the expansion was installed too:
its `missionpack/` holds the three patch paks and no `pak0.pk3`, so the `mp*` maps are simply not
there. The converter says so rather than inventing them.

## Q3.2 IBSP v46, and what it buys over GoldSrc

Same family five years on, and the differences all favour the converter:

| | GoldSrc v30 | Quake 3 v46 |
|---|---|---|
| face UVs | projected from two texinfo axes | **stored per vertex** |
| lightmap | per-face luxel block, packed by the converter | **finished 128×128 pages, one UV per vertex** |
| normals | face plane only | **per vertex** |
| geometry | convex polygons | polygons, triangle soups **and bezier patches** |
| textures | 8-bit miptex in a WAD | 24/32-bit `.tga` and `.jpg` in a zip |

`textures/` also carries `flags` and `contents` per surface, so a converter can tell sky from clip
from water without parsing a single shader script.

## Q3.3 A third of a map is not polygons

Face `type` is 1 polygon, 2 **bezier patch**, 3 **triangle mesh**, 4 billboard flare. q3dm1 has 113
patches and 42 meshes out of 2097 faces; q3ctf3 has 358 patches, and every curved arch, pipe and
terrain hill in the game is one of them.

A patch is a `size[0] × size[1]` grid of control points, both odd, holding
`((w-1)/2) × ((h-1)/2)` biquadratic sub-patches that share their edge rows. Tessellating each
sub-patch into an `(L+1)²` grid and stitching by index is what the engine does; the seam between two
sub-patches is exact because they share the control row, so no welding is needed. `L = 4` is the
default here (`--patch-level`), which turns the game's patches into 8k–50k triangles a map.

Type 4 flares are a sprite the engine draws for a light corona. There is nothing to convert — 13 of
them on q3dm17 — so they are dropped and counted.

## Q3.4 A surface names a SHADER, not a file

Most surface names happen to be an image with the extension left off, and 78 of q3dm1's 94 resolve
that way. The interesting ones do not exist on disk at all: `textures/liquids/lavahell_750`,
`textures/skies/tim_hell`, every `*_trans` pane and every flame. Those are scripts in
`scripts/*.shader`, and the only way to learn which image to draw — and how — is to read them.

What the converter takes from a shader:

* the **diffuse stage's image**. Not the first stage: a two-pass shader puts `$lightmap` in one stage
  and the texture in the other with `blendFunc filter`, so "the first stage" is the wrong answer as
  often as the right one. Prefer a stage whose blend is opaque or filter, then any real image, then
  `qer_editorimage`.
* the **extension is a hint, not a fact** — half of id's own shaders say `.tga` for an image that
  shipped as `.jpg` once the paks were rebuilt. Try both.
* `alphaFunc` → a cut-out; `blendFunc blend` → translucent; `blendFunc add` → additive;
  `cull none` → two-sided; `surfaceparm fog` → a volume with no picture at all, skipped.

With that, 2733 of 2733 surface shaders in `baseq3` and 4458 of 4458 in `missionpack` resolve.

## Q3.5 `blendFunc GL_add` is id's own typo, and it cost 180 shaders

`sfx.shader` contains `blendFunc GL_add` — a one-word blend spelled like a two-word one. A parser
that sees the `GL_` prefix and consumes a second token takes the stage's closing `}` as the
destination factor, and from there every brace is off by one: **35 of that file's 215 shaders
parsed**, and the 180 that did not include every flame, fog and tesla coil in the game.

The rule that fixes it is worth more than the special case: **a brace is never an argument**, and a
blend factor is always `GL_*`, so look at the next token before consuming it. There is one runnable
check for exactly this in `test/selfcheck.js`.

...and the same line had a second bug in it, which cost more: the `GL_` test was **case-sensitive**,
and id writes its factors in capitals. Every `blendFunc GL_ONE GL_ONE` was therefore read as the
one-word form and classified opaque, so the 227 additive shaders in baseq3 - every flame, every
lamp glow, every portal effect - came across as opaque rectangles with a black background painted
on them. One `/i` turned all of them back into the sprites they are.

## Q3.5a A flipbook is `animMap`, and Killing Floor can play it

An animated Quake 3 surface is a stage with `animMap <fps> <frame> <frame> ...`, and the frames are
ordinary images. Killing Floor animates a texture through `AnimNext` - one texture per frame, the
last pointing back at the first, `MinFrameRate`/`MaxFrameRate` for the speed - which the Lineage 2
route already used for its own flipbooks. So every frame is written and chained, and a torch on
q3ctf1 burns rather than standing still: 16 textures in two chains on that map alone.

## Q3.6 The lightmap is already the shape UE2.5 wants

GoldSrc hands the converter a luxel block per face and it has to pack them into atlas pages itself.
Quake 3 hands it **finished 128×128 RGB pages** and a lightmap UV per vertex, which is precisely
what a second UV channel and a `Combiner` want. So the map's own baked light goes across with no
repacking at all: one `UTexture` per page, one `TexCoordSource` reading it through `TCS_Stream1`, one
`Combiner(texture × page)` per material, and the meshes group by `(material, page)` because a mesh
carries one of each.

Pages per map run 5–48 in `baseq3` and up to 108 (`mpteam7`) in Team Arena.

They are written **uncompressed**. A page is stretched over a whole room, so one DXT block covers
several feet of wall and its two endpoint colours read as film grain on the stonework — see
GOTCHAS 5.39 for the same fault on the wall textures. At 128×128 an RGBA8 page is 87 KB with its
mips, which is the cheapest place in the map to spend them.

## Q3.7 Quake 3's lightmaps are dark on purpose

Mean luxel over the stock maps, of 255:

| | mean | at exactly 0 |
|---|---|---|
| `baseq3` | 12–35 | 20–57% |
| `missionpack` | 8–43 | 26–69% |

The engine doubles them on load (`r_mapOverBrightBits`) and the hardware gamma ramp lifts them
again, so what looks black in the file is a lit wall on screen. Nothing in UE2.5 does either, so the
atlas is scaled on the way in: **×4.0, plus a floor of 20** (`--light-gain`, `--light-floor`). The
floor is not optional — a luxel of 0 multiplies the wall's texture to black and no torch and no
muzzle flash can ever reach it (GOTCHAS 4.11b), and that is a third of every stock map.

## Q3.8 A surface with no lightmap carries its light per VERTEX

`lm_index = -1` is what the compiler writes for everything a shader marked `nolightmap`: the sky, the
flames, the light panels, the panes — and every `misc_model`. Quake 3 lights exactly those from the
per-vertex colour in the vertex lump, sampled out of the light grid at compile time.

So do the same: those meshes ship Quake 3's own vertex colour in the mesh's colour stream (×2, the
same doubling the lightmap gets) and take **no `AmbientGlow`**, because that stream ADDS to whatever
lights the actor rather than multiplying it (GOTCHAS 4.10a). A lightmapped mesh is the other way
round — colour stream at zero, light in the material, glow on the actor.

Getting this wrong is visible immediately: with a flat glow instead, q3dm1's two courtyard statues
stand there as flat white cut-outs.

## Q3.9 Most stock skies have no farbox at all

A sky shader carries `skyparms <farbox> <cloudheight> <nearbox>`, and a farbox is six images named
`<farbox>_{rt,lf,ft,bk,up,dn}` — the same six sides, in the same Quake layout, the GoldSrc route
already draws on a cube (GOTCHAS/goldsrc 5.16).

But **30 of `baseq3`'s 34 sky surfaces and 47 of Team Arena's 61 set the farbox to `-`** and paint
the sky with two scrolling cloud LAYERS instead. Nothing in UE2.5 reproduces a scrolling dome, so
those get a still picture on all six faces — but which picture matters twice over:

* **All the layers, composited, not just the first.** Team Arena's `xproto_sky2` draws a nearly
  black sheet ADDITIVELY over a lit one; taking the diffuse stage alone gets the black sheet and
  nothing else, which is how mpteam2 ended up with a black sky. The layers are now stacked the way
  the engine stacks them: the first as the base, the rest added, blended or multiplied over it.
* **Tiled, not stretched.** id's cloud stages carry `tcMod scale 3 4`, so one copy stretched over a
  whole cube face is four times too coarse. The composite is repeated 4x a side (a power of two,
  because a cube face has to stay one) before it is resampled up, which is where the "the sky looks
  low-resolution" complaint came from.

## Q3.10 Scale is 1.8634, and both bounds are the engines' own constants

A Quake 3 player is **30 × 30 × 56** — `playerMins {-15,-15,-24}`, `playerMaxs {15,15,32}` in
`bg_pmove.c` — and ducks to 40 by dropping `maxs[2]` to 16. `STEPSIZE` is **18 map units**, the
tallest step the game itself lets him walk up. Against `KFHumanPawn` (100 × 40 standing, 68 crouched)
and Killing Floor's `MAXSTEPHEIGHT` of 35, that gives five constraints, of which two bind:

| constraint | ratio | bound |
|---|---|---:|
| `KFHumanPawn`'s 100 uu through the tightest passage a Quake 3 mapper may build (56) | 100/56 | ≥ **1.7857** |
| a step the mapper was allowed to build (18) under `MAXSTEPHEIGHT` 35 | 35/18 | ≤ **1.9444** |
| a 52-uu-wide specimen through a 30-unit passage | 52/30 | ≥ 1.7333 |
| a crouched `KFHumanPawn` (68 uu) through Quake 3's ducked hull (40) | 68/40 | ≥ 1.7000 |
| a specimen's 88 uu of height through the same 56-unit passage | 88/56 | ≥ 1.5714 |

The window is 8.9 % wide. Both bounds are ratios, so the value at equal relative margin from each is
their geometric mean:

```text
sqrt(100/56 x 35/18) = 1.863390
```

A 56-unit passage arrives at 104.3 uu against the 100 the pawn needs; an 18-unit step arrives at
33.5 uu against the 35 limit. `test/selfcheck.js` asserts both.

**The eye agrees, which is the part that is not a coincidence.** Quake 3's view sits at
`MINS_Z` −24 + `DEFAULT_VIEWHEIGHT` 26 = **50 uu off the floor**, `KFHumanPawn`'s at
`CollisionHeight` 50 + `BaseEyeHeight` 44 = 94. Camera parity is 94/50 = **1.88**, within 1 % of the
mean. Quake 3 is the only one of the four routes where the clearance window and the camera land on
the same number — on the Counter-Strike route camera parity is 1.4688 against a window starting at
1.8889, which is why that route needs a field-of-view argument and this one does not.

*(An earlier version of this note put the eye figure at ×2.4. That was 1.9 × 72/56 — the
Counter-Strike scale rescaled by the ratio of the two players — not Quake 3's own camera, and it is
wrong.)*

*(The 35 is the engine's own constant. It is not a `Pawn` variable in this build — nothing under the
SDK's `Engine/Classes` declares `MaxStepHeight` — so it could not be read back from the game files
here, and the harness drives the console rather than the player, so it could not be walked either.
The stock staircases this converter has been run against are 8 and 16 units, which clear the bound
with room to spare at 15 and 30 uu.)*

*(Quake 3's own constants could not be read from the local install either: `pak0.pk3` ships the game
logic as compiled QVM bytecode. They are id's published GPL source, the same footing as the
Half-Life SDK constants the Counter-Strike route uses.)*

What does not survive the scale is the **jump**. `JumpZ=325` against Killing Floor's gravity of −950
clears 55.6 uu; Quake 3's `JUMP_VELOCITY` 270 against its own 800 clears 45.6 map units, which is 85
uu here. Ledges a Quake player hops onto need a run-up, and the ones that needed a rocket jump are
out of reach. No scale fixes that — the ratio of jump to step is a property of the two games, not of
the conversion.

## Q3.11 The props are already in the BSP

`misc_model` places an `.md3` in Radiant, and **q3map compiles its triangles into the map** as
ordinary type-3 faces with the model's own textures. So the statues, the torches, the wall heads and
the lamps come across for free, with their light in the vertex colours (Q3.8) — no model reader, no
per-instance actors, nothing like the `.mdl` work the GoldSrc route needs.

## Q3.12 The tool surfaces are already gone, and the clip brushes are not

q3map removes `caulk` and `nodraw` faces from the map entirely: not one face of q3dm1 references
`textures/common/caulk`, even though the texture is in the lump. What survives is the **brushes** —
`clip`, `weapclip`, `hint`, `donotenter`, `trigger` — and their `contents` flags say so, so they are
recognised and skipped rather than converted into invisible walls.

Collision comes from the meshes' own kDOP trees, so the clip brushes are not missed. What IS missed
is the places a mapper used a clip brush to smooth a staircase or block a gap; those play as the raw
geometry.

## Q3.11a `tcMod scale` is part of the surface, not an effect

A Quake 3 stage may carry `tcMod scale <u> <v>`, and Team Arena's terrain shaders all do:
`tcmod scale 0.125 0.125` on both rock layers. It is not an animation - it is a fixed multiplier on
the UVs - so ignoring it draws the ground with a texture **eight times too large**, which is what
made mpterra1's hillsides read as flat patches of colour with hard edges between them. The scale is
baked into the vertex UVs at build time. The animated tcMods (`scroll`, `turb`, `rotate`, `stretch`)
have no equivalent here and are skipped, arguments and all.

### Both layers, blended by the vertex alpha

A terrain shader is two rocks and a weight: `mpterra1_0to1` draws `pjrock9c` and then `pjrock12c`
over it with `blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA` and `alphaGen vertex` — the weight is
painted per vertex, not into a texture. Carrying only the first stage is one flat rock with a hard
edge wherever the blend was.

A static mesh cannot sample a second texture with a second set of UVs, but it can carry a colour per
vertex, and `Engine.VertexColor` hands that colour to whatever asks for it. So the surface is drawn
**twice**: the base as usual, then the same triangles again with the second texture, its own
`tcMod scale`, and the material

```
FinalBlend{ FrameBufferBlending = FB_AlphaBlend, ZWrite = false,
            Material = Shader{ Diffuse = layer2, Opacity = VertexColor, OB_Translucent } }
```

which is the shape the Lineage 2 route already uses for its own terrain layers. The overlay pass
carries the blend weight in the vertex ALPHA, collides with nothing (it is coplanar with the surface
underneath), and is grouped into meshes of its own. Nine shaders in Team Arena paint a second layer
this way; mpterra1 uses two of them.

What it costs, measured on the finished `.rom`:

| map | triangles | vertices | size |
| --- | --- | --- | --- |
| mpterra1 | 33236 → 34422 (**+3.6%**) | 46842 → 48143 | 16.83 → 17.38 MB |
| mpterra2 | 42641 → 45429 (**+6.5%**) | 65313 → 68345 | 20.60 → 21.17 MB |

Only the painted surfaces are drawn twice, so every other stock map is byte-identical: `baseq3` has
**0** shaders of this shape out of 1510, and of Team Arena's maps only the two terrain ones use any.
That is an order of magnitude cheaper than the Lineage 2 route's layer blend (3x the ground's
triangles), so it is on by default — `--no-terrain-layers`, or the checkbox in the desktop app,
turns it off.

## Q3.12a Water, jump pads and teleporters are brushes, not surfaces

Three things a Quake 3 map keeps in its BRUSHES rather than in anything that draws:

* **Water.** The surface you see is an ordinary face; the swimming is `CONTENTS_WATER` on the brush
  behind it. Carrying only the face gives a picture you fall straight through, which is what
  mpteam5 did. Every liquid brush's bounds are read off its own side planes - the axis-aligned ones
  are the box, the bevels a compiler adds are skipped - and become a `PhysicsVolume`, the same actor
  the GoldSrc and Tactical Ops routes write. 94 of them on mpteam5, 16 deep enough to swim in.
* **Jump pads.** `trigger_push` is a brush entity that names a `target_position`. Killing Floor has
  `XGame.xKicker`, which throws whatever touches it - and it throws nothing at all unless its
  `KickedClasses` array names a class, which the class defaults leave empty. The launch is re-solved
  for Killing Floor's gravity (950 uu/s²), not carried: rise to the target's height, cover the
  horizontal distance in that time.
* **Teleporters.** `trigger_teleport` names a destination the same way, and becomes a pair of
  `Engine.Teleporter`s - one at the trigger with its `URL` naming the other's `Tag`.

The brush-bounds routine is shared by all three, and `Engine.Kicker` does not exist in Killing
Floor: importing it by that name is a map that never finishes loading.

## Q3.13 What a Quake 3 map carries that this does not

* **Movers.** `func_door` becomes a `KFDoorMover` with its `KFUseTrigger` — opened with the use key
  and weldable, like a native KF door — because a Quake 3 door left closed seals a corridor for
  good. `func_plat`, `func_bobbing`, `func_rotating`, `func_train` and `func_button` stay static
  geometry where they stand.
* **Everything animated.** Scrolling clouds, `tcMod` warps, `deformVertexes` and rgbGen waves come
  across as their first frame; `animMap` flipbooks do animate (Q3.5a).
* **Fog volumes.** `surfaceparm fog` is a volume, not a surface; carried as geometry it is a grey
  slab across the level, so it is skipped. The nine `sfx/*fog*` shaders in `baseq3` are all of these.
* **Items, weapons, bots.** No `item_*` pickups, no bot routing (`.aas` is a separate file this does
  not read), no `ZombieVolume`s — a converted map has nothing to fight until somebody places them.

## Q3.14 What a stock map costs, measured

Converted with the defaults, verified with `--verify`, and run in the client:

```
q3dm1    2097 faces ->  15928 tris in  172 meshes   9 lm pages   7.8 MB
q3dm6    4318 faces ->  29760 tris in  288 meshes  17 lm pages  10.9 MB
q3ctf3   8069 faces ->  66689 tris in  554 meshes  34 lm pages  17.0 MB
mpteam5 21687 faces ->  68333 tris in 1107 meshes  48 lm pages  18.2 MB
mpterra2 9079 faces ->  42449 tris in 1415 meshes  71 lm pages  17.6 MB
```

59 maps of both games convert, pass all 28 invariants of the finished `.rom`, and reach a live
first-person view in the client with no `Critical:` line in `KillingFloor.log`.

## What a second play-test turned up

### Q3.10 A blendFunc is two FACTORS, not a pair to pattern-match
`result = src*SRC + dst*DST`, and the only thing a converter needs from it is "does this pass let
the background through". Matching the pairs id happens to write missed five of them, and one of the
five was 42 of q3dm7's wall faces: `blendFunc GL_DST_COLOR GL_SRC_ALPHA` (208 stages across baseq3
and Team Arena) is a specular-lit wall - the texture MULTIPLIES the lightmap already on the screen
and adds a little shine - and falling through to "blend" made `gothic_wall/iron01_m` a pane of glass
you could see the next room through.

The rule that holds: a source factor taken from the DESTINATION (`GL_DST_COLOR`,
`GL_ONE_MINUS_DST_COLOR`, `GL_ZERO`) can only scale what is already in the buffer, so it is a filter
- opaque - unless the destination factor is `GL_ONE`, which brightens. `GL_SRC_ALPHA` with
`GL_ONE_MINUS_SRC_ALPHA` (and its two mirrors) is the only real alpha blend. Everything left over
adds.

### Q3.11 A shader is named after the picture it draws, and the stages before it are the BACKDROP
"The first opaque stage" is the wrong answer whenever a shader paints its own texture over
something: `base_trim/pewter_shiney` blends its metal over an environment map, and
`base_floor/metalbridge04dbroke` blends a broken plate over a scrolling electric one - that plate's
alpha IS the hole in the floor. Taking the first stage drew `effects/tinfx` on every pewter rail in
the game and left the hole flat black; 5455 of baseq3's 147056 faces and 20357 of Team Arena's
317596 (15.5% of q3tourney4 alone) were on the wrong stage.

So: the stage whose image basename matches the shader name wins, the FIRST drawing stage decides
whether the surface is see-through, and what the drawn stage blends over is composited underneath it
at load. One material per surface is all UE2.5 draws, and the composite is what makes the hole a
hole again.

### Q3.12 `deformVertexes autoSprite` is a billboard, not a wall
25 shaders in baseq3 and 66 in Team Arena, and every lamp corona and glow bulb in the game is one:
`proto2/lightbulb`, `mapobjects/gratelamp/gratelamp_flare`, `mapobjects/slamp/slamp3`. Left as the
quad the file holds, each is a flat plate hanging in the air beside its lamp - 220 of them on
mpteam2. They become `Engine.Effects` sprites instead, at the quad's centre and size.

Only the roughly square ones: `autoSprite2` also carries the long thin quads of a wire or a hanging
chain, which spin about their own axis and are not billboards in any useful sense.

### Q3.13 Collision is a property of the BRUSH, and clip brushes do not survive
`CM_LoadMap` gives a brush the contents of its shader and a trace only hits what carries
`CONTENTS_SOLID`, so a light beam, a flame sheet and a `nonsolid` grate are walked through in Quake 3
- while this converter takes its collision from the mesh triangles. Every lamp's beam on mpteam2 was
a wall to bump into.

Deliberately narrower than "no CONTENTS_SOLID": Quake 3 also blocks with invisible `common/clip`
brushes, which q3map emits no drawsurface for and this converter therefore cannot carry, so a fence
whose own brush is not solid would become a hole in the level. Only `SURF_NONSOLID`, and a
see-through surface whose brush is not solid either, are opened up.

### Q3.14 `tcMod scroll` and `tcMod rotate` have exact equivalents here
`Engine.TexPanner` (PanDirection + PanRate, in texture widths per second) and `Engine.TexRotator`
(`TR_ConstantlyRotating`, Rotation.Yaw). 4066 faces in baseq3 and 9001 in Team Arena are animated
this way - the slime, the water, the light beams, the portal rings and the teleporters' energy
sheets, which stood still while the animMap flipbooks moved. The Modifier wraps the TEXTURE, under
the Combiner, so the lightmap the Combiner reads through UV channel 1 is not dragged along with it.

### Q3.15 One trigger per door, not one per mesh
The mesh builder splits a brush entity by material and by lightmap page, so a door arrives as several
meshes. Each has to move, and each does - they share the mover's Tag. The `KFUseTrigger` must not be
split with them: `KFDoorMover.PostBeginPlay` keeps the FIRST trigger whose `Event` matches its Tag,
warns "Multiple triggers found!" for the rest, and the player is left in front of as many use prompts
as the door had materials. q3dm12: 88 movers, 34 triggers.
