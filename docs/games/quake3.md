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
those get the cloud image itself on all six faces: a still sky of the map's own colour and clouds,
seams and all, which is a great deal closer than a flat blue. q3dm1's hell sky and q3dm17's black
void both come out right this way.

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

## Q3.13 What a Quake 3 map carries that this does not

* **Movers.** `func_door` becomes a `KFDoorMover` with its `KFUseTrigger` — opened with the use key
  and weldable, like a native KF door — because a Quake 3 door left closed seals a corridor for
  good. `func_plat`, `func_bobbing`, `func_rotating`, `func_train` and `func_button` stay static
  geometry where they stand.
* **Jump pads, teleporters, launchers.** `trigger_push`, `trigger_teleport` and their targets are
  gameplay this engine has no equivalent for. A map that needs a jump pad to reach a ledge has that
  ledge out of reach.
* **Fog volumes.** `surfaceparm fog` is a volume, not a surface; carried as geometry it is a grey
  slab across the level, so it is skipped. The nine `sfx/*fog*` shaders in `baseq3` are all of these.
* **Everything animated.** Scrolling clouds, `tcMod` warps, `deformVertexes`, animMap flames and
  rgbGen waves come across as their first frame.
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
