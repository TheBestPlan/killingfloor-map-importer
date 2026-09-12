// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

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
// A zone boundary. `PF_SpecialPoly | PF_ForceViewZone` is how Lineage 2 marks the "field" planes it
// divides a place up with - 25_14's cave is crossed by 61 of them and the client draws none. Carried
// across they are big flat pale slabs hanging in the room with gaps between them, which is what the
// hole in that cave's floor looked like (Screenshot_84).
//
// The FLAGS say it, not the texture: 61 `Godad_DC_field` polygons carry them and another 24 wearing
// the same texture do not - and those 24 are the floor the player walks in on. Skipping by name took
// the floor with them and opened the hole for real (Screenshot_86).
const PF_ZONE_FIELD = 0x00002000 | 0x00008000;
// How wide a horizontal zone boundary may be and still be a floor patch rather than the zone's own
// lid: the patch inside 25_14's cave is 194x664, the lid over it is 4329x9715.
const ZONE_PATCH = 2048;

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
  const stats = { add: 0, subtract: 0, skipped: 0, polys: 0, rotated: 0, scaled: 0, unreadable: 0, field: 0, patched: 0 };
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
      // Kept, not dropped: it is not drawn, but the carve still needs its plane. A doorway is cut
      // flush with the wall it goes through, and if that wall is one of these the passage has no
      // other plane to recognise the cut by - which is how the cave mouth got sealed from inside.
      let hidden = sink === out && (poly.polyFlags & PF_ZONE_FIELD) === PF_ZONE_FIELD;
      if (sink === out && opts && opts.solidOnly && (poly.polyFlags & PF_NOT_SOLID)) continue;
      const vertices = poly.vertices.map((v) => [
        v[0] + loc[0] - pp[0], v[1] + loc[1] - pp[1], v[2] + loc[2] - pp[2],
      ]);
      // Except a small horizontal one. A zone box has a lid and a floor as well as its four sides,
      // and where the floor of that box is what the player stands on it is the only surface there:
      // just inside 25_14's cave mouth it is a 194x664 patch at z=-2159 and nothing else is under
      // the ground at all (Screenshot_86/88). The lid and floor of the zone itself are 4329x9715 and
      // are not that - the bound is what tells them apart.
      //
      // Drawn BOTH ways round: it is the underside of the box, so its normal points away from the
      // player walking on it and one winding alone would leave it see-through from above.
      const flat = Math.abs(poly.normal[2]) > 0.5;
      let span = 0;
      if (hidden && flat) {
        for (let a = 0; a < 2; a++) {
          let lo = Infinity, hi = -Infinity;
          for (const v of vertices) { if (v[a] < lo) lo = v[a]; if (v[a] > hi) hi = v[a]; }
          span = Math.max(span, hi - lo);
        }
      }
      const patch = hidden && flat && span <= ZONE_PATCH;
      if (patch) { hidden = false; stats.patched++; }
      if (hidden) stats.field++;
      const made = {
        brush: index, seq: order, hidden,
        vertices,
        base: [poly.base[0] + loc[0] - pp[0], poly.base[1] + loc[1] - pp[1], poly.base[2] + loc[2] - pp[2]],
        normal: poly.normal, textureU: poly.textureU, textureV: poly.textureV,
        polyFlags: poly.polyFlags,
        texture: poly.texture ? refTarget(pkg, poly.texture) : null,
      };
      sink.push(made);
      if (patch) {
        sink.push(Object.assign({}, made, {
          vertices: vertices.slice().reverse(),
          normal: [-poly.normal[0], -poly.normal[1], -poly.normal[2]],
        }));
        stats.polys++;
      }
      if (sink === out && !hidden) stats.polys++;
    }
    if (sink === out) stats.add++;
  }
  return { polys: out, carved, stats };
}

module.exports = { readBrushes, readPolys };
