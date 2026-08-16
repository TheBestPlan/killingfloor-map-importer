# Counter-Strike 1.6 / GoldSrc

What reading a GoldSrc `.bsp` costs, and what its own conventions do to a conversion. Every entry
was measured against the shipped game files or seen in the running client.

The engine these end up in - Killing Floor, Unreal Engine 2.5 - has its own notes in
[`../GOTCHAS.md`](../GOTCHAS.md), and the other source game in
[`lineage2.md`](lineage2.md).

**The numbers are historical.** They are the ones these entries had while everything lived in one
file, and the code still cites some of them (`GOTCHAS 5.31a`), so they stay put rather than being
renumbered into a tidy sequence.

---

### 5.2 GoldSrc masks on palette index 255, Unreal on index 0
Swapping the two indices *and* the two palette entries preserves every other colour exactly.

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
