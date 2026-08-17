// The brush geometry of a Lineage 2 square.
//
// A town is not only static meshes: its floors, walls and stairs are CSG brushes, and in 16_12 there
// are 293 of them - 173 additive, 119 subtractive - sitting at the same depth as the town's meshes.
// Without them the town has nothing to stand on.
//
// What is read is the brushes' OWN polygons, not the compiled world BSP. The compiled model is a
// UE2.0 FBspNode array whose field list this converter cannot yet reproduce (the node index count
// and its tail moved between 123 and 128, and a brute force over the plausible shapes found nothing
// self-consistent), while UPolys is the same object the Killing Floor writer already emits:
//
//   props(None) | INT Num | INT Max | per poly: cidx numVerts, FVector base/normal/textureU/
//   textureV, the vertices, DWORD polyFlags, cidx actor/texture/itemName/iLink/iBrushPoly,
//   FLOAT ShadowMapScale, DWORD -1
//
// Subtractive brushes are skipped rather than carved: CSG is a whole subsystem, and an additive-only
// town is a town with its floor, which is what the player needs to stand on.
"use strict";

const { Rd } = require("../unreal/read");
const { tagsOf, pick, val, refTarget } = require("./props");

const PF_INVISIBLE = 0x00000001;
const PF_NOT_SOLID = 0x00000008;
const PF_PORTAL = 0x04000000;
const PF_FAKE_BACKDROP = 0x00000080;

function readPolys(pkg, exp) {
  const r = new Rd(pkg.buf, exp.serialOffset);
  const end = exp.serialOffset + exp.serialSize;
  r.cidx();                                        // property block: "None"
  const num = r.i32();
  r.i32();                                         // Max
  if (num < 0 || num > 100000) throw new Error(exp.name + ": " + num + " polys is not a UPolys");
  const polys = [];
  for (let i = 0; i < num; i++) {
    if (r.pos >= end) throw new Error(exp.name + ": ran out at poly " + i + " of " + num);
    const n = r.cidx();
    if (n < 0 || n > 64) throw new Error(exp.name + ": poly " + i + " has " + n + " vertices");
    const base = r.vec(), normal = r.vec(), textureU = r.vec(), textureV = r.vec();
    const vertices = [];
    for (let k = 0; k < n; k++) vertices.push(r.vec());
    const polyFlags = r.u32();
    const actor = r.cidx(), texture = r.cidx(), itemName = r.cidx();
    r.cidx(); r.cidx();                            // iLink, iBrushPoly
    // The eight bytes after iBrushPoly are NOT PanU/PanV. This FPoly has no pan at all - the offset
    // lives in Base - and what is here is `FLOAT ShadowMapScale` and a sentinel word.
    //
    // Read as a pan they were catastrophic: measured over three squares, the first is only ever the
    // float 32, 64, 128 or 256 and the second is always -1. Added to a texture coordinate, 0x42000000
    // read as an integer is 1 107 296 256 texels, which collapses the float precision of the whole
    // surface - that is the smeared brown streaking over every brush floor and wall in a town.
    r.f32(); r.i32();                              // ShadowMapScale, and -1
    void actor; void itemName;
    polys.push({ vertices, base, normal, textureU, textureV, polyFlags, texture });
  }
  return polys;
}

// A brush's UModel does not name its Polys in a tagged property - the reference sits in the model's
// body, past the five geometry arrays (all empty on a brush) and the two zone counts. Walked out of
// a 72-byte model rather than assumed: props(1) box(25) sphere(16) | five empty arrays | INT
// NumSharedSides | INT NumZones | cidx Polys.
function brushPolysOf(pkg, model) {
  const r = new Rd(pkg.buf, model.serialOffset);
  const end = model.serialOffset + model.serialSize;
  r.cidx();
  r.vec(); r.vec(); r.u8();
  r.vec(); r.f32();
  for (let i = 0; i < 5; i++) if (r.cidx() !== 0) return null;   // a brush carries no compiled BSP
  r.i32(); const numZones = r.i32();
  if (numZones !== 0) return null;
  const ref = r.cidx();
  if (r.pos > end || ref <= 0 || ref > pkg.exports.length) return null;
  const exp = pkg.exports[ref - 1];
  return exp && pkg.classOf(exp) === "Polys" ? exp : null;
}

// Every additive brush in the square, as polygons already in world space.
//
// A brush actor stores its shape in brush-local coordinates and carries the transform: Location and
// PrePivot are what the editor moves, MainScale/PostScale and Rotation are rarely anything but the
// identity on a level brush, so only the two that matter are applied. Anything else shows up as a
// piece in the wrong place rather than silently - the count is logged.
function readBrushes(pkg, opts) {
  const out = [], carved = [];
  const stats = { add: 0, subtract: 0, skipped: 0, polys: 0, rotated: 0, scaled: 0, unreadable: 0 };
  // The order the brushes appear in is the order CSG applied them, and it decides what is solid: an
  // additive brush placed after a subtract fills that hole back in. Carrying the position lets the
  // carve (carve.js) subtract only the volumes that came BEFORE the wall they are cutting.
  let seq = 0;
  for (const e of pkg.exports) {
    const cls = pkg.classOf(e);
    if (!/Brush$/.test(cls) || !e.serialSize) continue;
    const { tags } = tagsOf(pkg, e);
    const opTag = pick(tags, "CsgOper");
    const op = opTag ? val.byte(pkg, opTag) : 1;     // CSG_Active(0)/Add(1)/Subtract(2)
    // A subtractive brush is not geometry - it is the space a block was hollowed out with - so it is
    // kept apart from the polygons that get drawn. What it is good for is knowing where the inside
    // of a building IS: a dungeon is one big additive block with its halls subtracted out of it, and
    // without the second list "inside a brush" cannot tell a hall from a rock.
    if (op === 2) stats.subtract++;
    const sink = op === 2 ? carved : out;
    const brushTag = pick(tags, "Brush");
    if (!brushTag) { stats.skipped++; continue; }
    const target = refTarget(pkg, val.ref(pkg, brushTag));
    const model = target && target.local;
    if (!model) { stats.skipped++; continue; }

    const polysExp = brushPolysOf(pkg, model);
    if (!polysExp) { stats.skipped++; continue; }

    let polys;
    try { polys = readPolys(pkg, polysExp); } catch (err) { stats.unreadable++; continue; }

    const locTag = pick(tags, "Location"), ppTag = pick(tags, "PrePivot");
    const loc = locTag ? val.vector(pkg, locTag) : [0, 0, 0];
    const pp = ppTag ? val.vector(pkg, ppTag) : [0, 0, 0];
    if (pick(tags, "Rotation")) stats.rotated++;
    if (pick(tags, "MainScale") || pick(tags, "PostScale")) stats.scaled++;

    const index = op === 2 ? stats.subtract - 1 : stats.add;
    const order = seq++;
    for (const poly of polys) {
      // Invisible, portal and backdrop faces are not surfaces - they are how a mapper tells the
      // compiler what to do. Carrying them across would put grey slabs across the level. A carved
      // volume keeps them: it is not drawn, and a hall missing a wall is a hall that leaks.
      if (sink === out && (poly.polyFlags & (PF_INVISIBLE | PF_PORTAL | PF_FAKE_BACKDROP))) continue;
      if (sink === out && opts && opts.solidOnly && (poly.polyFlags & PF_NOT_SOLID)) continue;
      const vertices = poly.vertices.map((v) => [
        v[0] + loc[0] - pp[0], v[1] + loc[1] - pp[1], v[2] + loc[2] - pp[2],
      ]);
      sink.push({
        brush: index, seq: order,
        vertices,
        base: [poly.base[0] + loc[0] - pp[0], poly.base[1] + loc[1] - pp[1], poly.base[2] + loc[2] - pp[2]],
        normal: poly.normal, textureU: poly.textureU, textureV: poly.textureV,
        polyFlags: poly.polyFlags,
        texture: poly.texture ? refTarget(pkg, poly.texture) : null,
      });
      if (sink === out) stats.polys++;
    }
    if (sink === out) stats.add++;
  }
  return { polys: out, carved, stats };
}

module.exports = { readBrushes, readPolys };
