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
//   textureV, the vertices, DWORD polyFlags, cidx actor/texture/itemName/iLink/iBrushPoly, PanU/PanV
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
    // PanU/PanV are INTs here, not the WORDs Killing Floor writes: a six-poly object measured 114
    // bytes per poly against the 110 the WORD reading accounts for, and the four are these.
    const panU = r.i32(), panV = r.i32();
    void actor; void itemName;
    polys.push({ vertices, base, normal, textureU, textureV, polyFlags, texture, panU, panV });
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
  const out = [];
  const stats = { add: 0, subtract: 0, skipped: 0, polys: 0, rotated: 0, scaled: 0, unreadable: 0 };
  for (const e of pkg.exports) {
    const cls = pkg.classOf(e);
    if (!/Brush$/.test(cls) || !e.serialSize) continue;
    const { tags } = tagsOf(pkg, e);
    const opTag = pick(tags, "CsgOper");
    const op = opTag ? val.byte(pkg, opTag) : 1;     // CSG_Active(0)/Add(1)/Subtract(2)
    if (op === 2) { stats.subtract++; continue; }
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

    for (const poly of polys) {
      // Invisible, portal and backdrop faces are not surfaces - they are how a mapper tells the
      // compiler what to do. Carrying them across would put grey slabs across the level.
      if (poly.polyFlags & (PF_INVISIBLE | PF_PORTAL | PF_FAKE_BACKDROP)) continue;
      if (opts && opts.solidOnly && (poly.polyFlags & PF_NOT_SOLID)) continue;
      const vertices = poly.vertices.map((v) => [
        v[0] + loc[0] - pp[0], v[1] + loc[1] - pp[1], v[2] + loc[2] - pp[2],
      ]);
      out.push({
        vertices,
        base: [poly.base[0] + loc[0] - pp[0], poly.base[1] + loc[1] - pp[1], poly.base[2] + loc[2] - pp[2]],
        normal: poly.normal, textureU: poly.textureU, textureV: poly.textureV,
        panU: poly.panU, panV: poly.panV, polyFlags: poly.polyFlags,
        texture: poly.texture ? refTarget(pkg, poly.texture) : null,
      });
      stats.polys++;
    }
    stats.add++;
  }
  return { polys: out, stats };
}

module.exports = { readBrushes, readPolys };
