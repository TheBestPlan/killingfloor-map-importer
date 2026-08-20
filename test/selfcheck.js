// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Runnable checks for the pieces that would silently produce a broken map.
// Run: node test/selfcheck.js  [pathToKFMaps] [pathToCSMaps]
"use strict";

const fs = require("fs");
const path = require("path");
const { Writer } = require("../src/unreal/writer");
const R = require("../src/unreal/read");
const { writeModel } = require("../src/unreal/model");
const bsp = require("../src/goldsrc/bsp");
const dxt = require("../src/unreal/dxt");
const spr = require("../src/goldsrc/spr");
const { resample } = require("../src/build/upscale");

// Game files come from the installs found on this machine; KF_MAPS_DIR / CS_MAPS_DIR override, and
// the two positional arguments override those. Missing games fail their checks rather than skip.
const { steamApp } = require("../src/resources");
const under = (app, ...rest) => { const root = steamApp(app); return root ? path.join(root, ...rest) : ""; };
const KF_MAPS = process.argv[2] || process.env.KF_MAPS_DIR || under("KillingFloor", "Maps");
const CS_MAPS = process.argv[3] || process.env.CS_MAPS_DIR || under("Half-Life", "cstrike", "maps");

// Byte compare that tolerates one unavoidable difference: some shipped maps store *signalling*
// NaN floats, and reading them through a JS number normalises them to quiet NaN. The value is
// still NaN, so the round-trip is semantically exact.
function compare(a, b) {
  if (a.length !== b.length) return "length differs";
  let firstReal = -1, nanOnly = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    let excused = false;
    for (let s = Math.max(0, i - 3); s <= i && s + 4 <= a.length; s++) {
      if (Number.isNaN(a.readFloatLE(s)) && Number.isNaN(b.readFloatLE(s))) { excused = true; break; }
    }
    if (excused) nanOnly++;
    else if (firstReal < 0) firstReal = i;
  }
  if (firstReal >= 0) return "first real diff @" + firstReal;
  return null;
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ok   " + name + (detail ? "  (" + detail + ")" : "")); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  (" + detail + ")" : "")); }
};

console.log("compact index round-trip");
{
  const vals = [0, 1, 63, 64, 127, 128, 8191, 8192, 1 << 20, (1 << 28) - 1, -1, -63, -64, -100000];
  let allOk = true;
  for (const v of vals) {
    const w = new Writer(16); w.cidx(v);
    const r = new R.Rd(Buffer.from(w.out()), 0);
    const got = r.cidx();
    if (got !== v || r.pos !== w.len) { allOk = false; console.log("    " + v + " -> " + got + " (" + w.len + " B)"); }
  }
  ok("cidx encodes and decodes every probe value", allOk, vals.length + " values");
}

console.log("\nFString round-trip");
{
  const w = new Writer(64); w.fstring("unreal"); w.fstring(""); w.fstring("Index.unr");
  const r = new R.Rd(Buffer.from(w.out()), 0);
  ok("fstring", r.fstring() === "unreal" && r.fstring() === "" && r.fstring() === "Index.unr" && r.pos === w.len);
}

console.log("\nUModel serializer round-trip against shipped maps");
{
  const fakePkg = { names: { none: 0 } };
  let maps = [];
  try { maps = fs.readdirSync(KF_MAPS).filter((f) => f.toLowerCase().endsWith(".rom")); } catch (e) { }
  let checked = 0, exact = 0;
  const bad = [];
  for (const f of maps) {
    const file = path.join(KF_MAPS, f);
    let pkg, exp, m;
    try {
      pkg = R.load(file);
      exp = R.findWorldModel(pkg);
      if (!exp) continue;
      m = R.readModel(pkg, exp);
    } catch (e) { bad.push(f + ": read " + e.message); continue; }
    checked++;
    const w = writeModel(fakePkg, m);
    const buf = Buffer.from(w.out());
    for (const p of w.lazyPatches) buf.writeInt32LE(exp.serialOffset + p.target, p.at);
    const orig = pkg.buf.subarray(exp.serialOffset, exp.serialOffset + exp.serialSize);
    const diff = compare(buf, orig);
    if (diff === null) exact++;
    else bad.push(f + ": " + buf.length + " vs " + orig.length + " bytes, " + diff);
  }
  ok("world UModel re-serializes byte-identically", checked > 0 && exact === checked, exact + "/" + checked + " maps");
  for (const b of bad.slice(0, 5)) console.log("    " + b);
}

console.log("\nGoldSrc BSP reader");
{
  let maps = [];
  try { maps = fs.readdirSync(CS_MAPS).filter((f) => f.toLowerCase().endsWith(".bsp")); } catch (e) { }
  let checked = 0, lmOk = 0, windOk = 0, planeOk = 0;
  for (const f of maps) {
    let m;
    try { m = bsp.load(path.join(CS_MAPS, f)); } catch (e) { continue; }
    checked++;
    // 1. the computed luxel footprint must fit the LIGHTING lump (within the compiler's own slack)
    let bytes = 0;
    for (const face of m.faces) {
      const lm = m.faceLightmap(face);
      if (lm) bytes += lm.width * lm.height * 3 * lm.styles;
    }
    if (bytes <= m.lighting.len * 1.05) lmOk++;
    // 2. GoldSrc winds faces so the right-handed Newell normal is the NEGATED face normal
    // 3. every face vertex lies on the face plane
    let wind = true, onPlane = true;
    for (let i = 0; i < m.faces.length; i += Math.max(1, Math.floor(m.faces.length / 200))) {
      const face = m.faces[i];
      const ring = m.faceVertices(face);
      if (ring.length < 3) continue;
      let nx = 0, ny = 0, nz = 0;
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k], b = ring[(k + 1) % ring.length];
        nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      const N = m.faceNormal(face), D = m.faceDist(face);
      if ((nx * N[0] + ny * N[1] + nz * N[2]) / len > -0.9) wind = false;
      for (const p of ring) if (Math.abs(p[0] * N[0] + p[1] * N[1] + p[2] * N[2] - D) > 0.5) onPlane = false;
    }
    if (wind) windOk++;
    if (onPlane) planeOk++;
  }
  ok("lightmap footprint fits the LIGHTING lump", checked > 0 && lmOk === checked, lmOk + "/" + checked);
  ok("face winding is Newell == -normal", checked > 0 && windOk === checked, windOk + "/" + checked);
  ok("face vertices lie on the face plane", checked > 0 && planeOk === checked, planeOk + "/" + checked);
}

console.log("\nDXT3 encoder");
{
  const w = 8, h = 8;
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { rgb[i * 3] = (i * 4) & 255; rgb[i * 3 + 1] = 128; rgb[i * 3 + 2] = 255 - ((i * 4) & 255); }
  const enc = dxt.encodeDXT3(rgb, w, h);
  ok("DXT3 block count", enc.length === (w / 4) * (h / 4) * 16, enc.length + " bytes");
  const dec = dxt.decodeDXT3(enc, w, h);
  let maxErr = 0;
  for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) maxErr = Math.max(maxErr, Math.abs(dec[i * 4 + c] - rgb[i * 3 + c]));
  ok("DXT3 round-trip error is within block-compression limits", maxErr <= 24, "max channel error " + maxErr);
  const flat = Buffer.alloc(4 * 4 * 3, 77);
  const fenc = dxt.encodeDXT3(flat, 4, 4);
  const fdec = dxt.decodeDXT3(fenc, 4, 4);
  let flatErr = 0;
  for (let i = 0; i < 16; i++) for (let c = 0; c < 3; c++) flatErr = Math.max(flatErr, Math.abs(fdec[i * 4 + c] - 77));
  ok("DXT3 is near-exact on flat blocks", flatErr <= 4, "error " + flatErr);
}

console.log("\nUPolys layout (brush shapes)");
{
  // The layout a Volume's or a Mover's brush is written in. Proof is an exact fit: read every
  // UPolys in the shipped maps with it and require the last poly to end on the object's last byte.
  const maps = fs.existsSync(KF_MAPS) ? fs.readdirSync(KF_MAPS).filter((f) => /\.rom$/i.test(f)).slice(0, 6) : [];
  let exact = 0, bad = 0, polys = 0;
  for (const f of maps) {
    let pkg;
    try { pkg = R.parsePackage(fs.readFileSync(path.join(KF_MAPS, f))); } catch (e) { continue; }
    for (const e of pkg.exports) {
      if (pkg.classOf(e) !== "Polys" || !e.serialSize) continue;
      const end = e.serialOffset + e.serialSize;
      const r = new R.Rd(pkg.buf, e.serialOffset);
      r.cidx();
      const num = r.i32(); r.i32();
      let good = true;
      for (let i = 0; i < num && good; i++) {
        const n = r.cidx();
        if (n < 3 || n > 128) { good = false; break; }
        r.skip(12 * 4).skip(12 * n);
        r.u32();
        r.cidx(); r.cidx(); r.cidx(); r.cidx(); r.cidx();
        r.i16(); r.i16();
        if (r.pos > end) good = false;
        polys++;
      }
      if (good && r.pos === end) exact++; else bad++;
    }
  }
  ok("every shipped UPolys fits the layout exactly", maps.length > 0 && polys > 0 && bad === 0,
    exact + " objects, " + polys + " polys, " + bad + " mismatched");

  // And the box we generate round-trips through it.
  const { writePolys, boxPolys, boxBrushModel } = require("../src/unreal/polys");
  const box = boxPolys([-10, -20, -30], [10, 20, 30]);
  ok("boxPolys makes six quads", box.length === 6 && box.every((p) => p.vertices.length === 4), box.length + " polys");
  const outward = box.every((p) => {
    const d = p.vertices.every((v) => (v[0] - p.base[0]) * p.normal[0] + (v[1] - p.base[1]) * p.normal[1] + (v[2] - p.base[2]) * p.normal[2] < 1e-6);
    return d;
  });
  ok("every box poly's vertices lie on its own plane", outward);
  const model = boxBrushModel([-10, -20, -30], [10, 20, 30]);
  ok("boxBrushModel is a closed 6-node chain", model.nodes.length === 6 && model.rootOutside === 1 &&
    model.nodes[5].iBack === -1 && model.nodes[0].iBack === 1 && model.nodes[5].iCollisionBound === 0,
    model.nodes.length + " nodes, " + model.points.length + " points, hull " + model.leafHulls.length + " ints");
}

console.log("\nGoldSrc scale against Killing Floor's own physics");
{
  const s = require("../src/convert").DEFAULTS.scale;
  // Floor: a crouched KFHumanPawn is 2 x CrouchHeight 34 = 68 uu, and the smallest crouch gap an HL
  // mapper may build is the 36-unit duck hull. Under this, every vent in the map is sealed.
  ok("the default scale keeps an HL duck gap crawlable in Killing Floor",
    36 * s >= 68, "36 x " + s + " = " + (36 * s).toFixed(2) + " uu, crouched pawn 68");
  // Ceiling: MAXSTEPHEIGHT is 35 uu against GoldSrc's STEPSIZE of 18 - the same bound the Quake 3
  // and Tactical Ops routes are held to below.
  ok("the default scale keeps an HL step climbable in Killing Floor",
    18 * s <= 35, "18 x " + s + " = " + (18 * s).toFixed(2) + " uu, limit 35");
}

console.log("\nGoldSrc .mdl reader");
{
  const dir = path.resolve(CS_MAPS, "../models");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /\.mdl$/i.test(n) && !/T\.mdl$/i.test(n)).slice(0, 15) : [];
  const mdl = require("../src/goldsrc/mdl");
  let read = 0, finite = 0, sized = 0;
  for (const n of files) {
    const m = mdl.load(path.join(dir, n));
    if (!m || !m.parts.length) continue;
    read++;
    let allFinite = true, lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (const part of m.parts) for (const tri of part.tris) for (const v of tri) {
      for (let c = 0; c < 3; c++) {
        if (!isFinite(v.pos[c])) allFinite = false;
        if (v.pos[c] < lo[c]) lo[c] = v.pos[c];
        if (v.pos[c] > hi[c]) hi[c] = v.pos[c];
      }
    }
    if (allFinite) finite++;
    // A prop that decoded with the wrong bone offset collapses to a point or explodes; anything
    // between a lamp and a building is plausible.
    const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    if (span > 1 && span < 4096) sized++;
  }
  ok("every .mdl decodes with finite vertices", files.length > 0 && read > 0 && finite === read, finite + "/" + read + " models");
  ok("decoded .mdl models have a plausible size", read > 0 && sized === read, sized + "/" + read + " between 1 and 4096 units");
}

console.log("\nGoldSrc .spr reader");
{
  const dir = path.resolve(CS_MAPS, "../../valve/sprites");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /\.spr$/i.test(n)).slice(0, 40) : [];
  let read = 0, sane = 0;
  for (const n of files) {
    const s = spr.load(path.join(dir, n));
    if (!s) continue;
    read++;
    if (s.width > 0 && s.height > 0 && s.width <= s.maxWidth && s.height <= s.maxHeight &&
      s.rgb.length === s.width * s.height * 3 && s.alpha.length === s.width * s.height) sane++;
  }
  ok("every .spr decodes to a full frame within its own bounds", files.length > 0 && read > 0 && sane === read,
    sane + "/" + read + " decoded of " + files.length + " files");

  // A glow is INDEXALPHA: one colour, alpha from the palette index. Read as an ordinary paletted
  // image it comes out a black square, so check the alpha really is a ramp.
  const glow = files.map((n) => spr.load(path.join(dir, n))).find((s) => s && s.texFormat === spr.INDEXALPHA);
  if (glow) {
    let lo = 255, hi = 0;
    for (const a of glow.alpha) { if (a < lo) lo = a; if (a > hi) hi = a; }
    ok("INDEXALPHA sprite carries a real alpha ramp", hi - lo > 32, "alpha " + lo + ".." + hi);
  }
}

console.log("\nLanczos resample");
{
  const w = 6, h = 6;
  const rgb = Buffer.alloc(w * h * 3, 128), alpha = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = i % 2 ? 255 : 0;
  const r = resample({ width: w, height: h, rgb, alpha }, 8, 8);
  ok("resample carries the alpha channel", !!r.alpha && r.alpha.length === 64, r.alpha ? r.alpha.length + " texels" : "dropped");
  const mean = r.alpha.reduce((a, b) => a + b, 0) / r.alpha.length;
  ok("resample preserves the alpha mean", mean > 100 && mean < 155, "mean " + mean.toFixed(1));
}

// What a Lineage 2 texture's alpha channel is FOR decides how the surface is blended, and getting
// it backwards is a wall you can see through. Three synthetic DXT5 mips, one of each answer.
console.log("\nLineage 2 alpha classification");
{
  const { alphaMode, TEXF } = require("../src/lineage2/texture");
  const blocks = (pairs) => {
    const b = Buffer.alloc(pairs.length * 16);
    pairs.forEach(([a0, a1], i) => { b[i * 16] = a0; b[i * 16 + 1] = a1; });
    return { format: TEXF.DXT5, mips: [{ data: b, width: 16, height: 16 }] };
  };
  const opaque = Array.from({ length: 16 }, () => [255, 255]);
  const cutout = Array.from({ length: 16 }, (_, i) => (i < 8 ? [0, 0] : [255, 255]));
  const gradient = Array.from({ length: 16 }, () => [40, 200]);
  ok("alpha of 255 everywhere is not transparency", alphaMode(blocks(opaque)) === "none", alphaMode(blocks(opaque)));
  ok("a hard 0/255 alpha is a cut-out", alphaMode(blocks(cutout)) === "mask", alphaMode(blocks(cutout)));
  ok("a mid-range alpha is a gradient", alphaMode(blocks(gradient)) === "blend", alphaMode(blocks(gradient)));
}

// A particle system travels as a property block, and the two halves have to agree: what the reader
// decodes out of a Lineage 2 package is what the writer puts into a Killing Floor one. Nested structs
// and dynamic arrays are where that goes wrong, so the round trip is the check.
console.log("\nParticle property blocks round-trip");
{
  const { Props } = require("../src/unreal/writer");
  const { Package } = require("../src/unreal/package");
  const { readBlock, writeBlock } = require("../src/lineage2/emitter");
  const pkg = new Package();
  const w = new Writer(512);
  const pr = new Props(w, pkg.names);
  pr.int("MaxParticles", 12);
  pr.bool("FadeOut", true);
  pr.float("FadeOutStartTime", 0.48);
  pr.structBlock("LifetimeRange", "Range", (s) => { s.float("Min", 3); s.float("Max", 5); s.end(); });
  pr.structBlock("StartSizeRange", "RangeVector", (s) => {
    for (const axis of ["X", "Y", "Z"]) s.structBlock(axis, "Range", (a) => { a.float("Min", 15); a.float("Max", 20); a.end(); });
    s.end();
  });
  pr.arrayProp("SizeScale", 2, (raw, s) => {
    for (const [t, v] of [[0, 1], [1, 0.5]]) { s.float("RelativeTime", t); s.float("RelativeSize", v); s.end(); }
  });
  pr.structRaw("SpinCCWorCW", "Vector", Buffer.alloc(12));
  pr.end();
  const buf = Buffer.from(w.out());
  const fake = { buf, names: pkg.names.list };
  const block = readBlock(fake, 0, buf.length);
  ok("a block with nested structs and arrays reads back", !!block, block ? block.length + " properties" : "walk did not land on the end");
  if (block) {
    const by = Object.fromEntries(block.map((p) => [p.name, p]));
    ok("scalars survive", by.MaxParticles.value === 12 && by.FadeOut.value === true &&
      Math.abs(by.FadeOutStartTime.value - 0.48) < 1e-6, "12 / true / 0.48");
    const axes = by.StartSizeRange && by.StartSizeRange.block;
    ok("a RangeVector is three Ranges", !!axes && axes.length === 3 && axes[0].block[1].value === 20,
      axes ? axes.map((a) => a.name).join(",") : "-");
    ok("an array keeps its elements", by.SizeScale.kind === "array" && by.SizeScale.items.length === 2 &&
      by.SizeScale.items[1][1].value === 0.5, by.SizeScale.kind + " x" + (by.SizeScale.items || []).length);
    ok("an atomic struct stays raw", by.SpinCCWorCW.kind === "structRaw" && by.SpinCCWorCW.bytes.length === 12,
      by.SpinCCWorCW.kind);
    // ...and writing it again produces the same bytes, which is what the converter relies on.
    const w2 = new Writer(512);
    const pr2 = new Props(w2, pkg.names);
    writeBlock(pr2, block);
    pr2.end();
    ok("writing the tree back reproduces the block", Buffer.from(w2.out()).equals(buf),
      Buffer.from(w2.out()).length + " vs " + buf.length + " bytes");
  }
}

// The heightfield has to land on the square of the world grid the client itself names in MapX/MapY.
// `TerrainInfo.Location` is the middle of it, and read as a corner every square's ground was half a
// square out of place in both axes - the town sank into it and every ground query answered about
// somewhere 16 thousand units away. Needs the client; skipped without one.
{
  const L2 = process.env.L2_CLIENT_DIR || "D:/games/L2 Interlude CUZUS";
  if (fs.existsSync(path.join(L2, "maps"))) {
    console.log("\nLineage 2 terrain lands on the world grid");
    const { Client } = require("../src/lineage2/package");
    const { readTerrain } = require("../src/lineage2/terrain");
    const client = new Client(L2);
    for (const name of ["19_21", "16_12", "23_18"]) {
      let t = null;
      try { t = readTerrain(client, client.get(name)); } catch (e) { }
      if (!t || t.mapX === null) continue;
      const c0 = t.vertex(0, 0);
      const want = [(t.mapX - 20) * 32768, (t.mapY - 18) * 32768];
      ok(name + " starts on its own grid square",
        Math.abs(c0[0] - want[0]) < 1 && Math.abs(c0[1] - want[1]) < 1,
        Math.round(c0[0]) + "," + Math.round(c0[1]) + " vs " + want.join(","));
    }
  }
}

// The grass is scattered rather than read: the client keeps a density map and a seed, not positions.
// What has to hold is that the density is what decides the count, that the same square scatters the
// same way twice, and that a blade lands on the ground rather than beside it.
console.log("\nLineage 2 decoration scatter");
{
  const { scatter } = require("../src/lineage2/deco");
  const N = 17;
  const terrain = {
    width: N, height: N,
    vertex(ix, iy) { return [ix * 128, iy * 128, ix * 4 + iy * 8]; },
    quadVisible() { return true; },
  };
  const grey = (v) => ({ width: 8, height: 8, data: Buffer.alloc(64, v) });
  const layer = { maxPerQuad: 4, seed: 5, randomYaw: true, scale: { min: 1, max: 2 }, showOnInvisible: true };
  const half = scatter(terrain, layer, grey(128), {});
  const full = scatter(terrain, layer, grey(255), {});
  ok("an empty density map grows nothing", scatter(terrain, layer, grey(0), {}).length === 0,
    scatter(terrain, layer, grey(0), {}).length + " plants");
  ok("twice the density is about twice the plants", full.length > half.length * 1.6 && full.length < half.length * 2.4,
    half.length + " -> " + full.length);
  ok("the same square scatters the same way twice",
    JSON.stringify(scatter(terrain, layer, grey(128), {})) === JSON.stringify(half), half.length + " plants");
  const off = half.filter((p) => {
    const want = (p.pos[0] / 128) * 4 + (p.pos[1] / 128) * 8;
    return Math.abs(p.pos[2] - want) > 0.01;
  });
  ok("every plant stands on the heightfield", off.length === 0, off.length + " of " + half.length + " off it");
  const sizes = half.map((p) => p.size);
  ok("the scale stays inside the layer's range",
    Math.min(...sizes) >= 1 && Math.max(...sizes) <= 2, Math.min(...sizes).toFixed(2) + ".." + Math.max(...sizes).toFixed(2));
  // A cap that fills up and stops leaves the whole far half of the square bare.
  const capped = scatter(terrain, layer, grey(255), { limit: 100 });
  const far = capped.filter((p) => p.pos[1] > (N - 2) * 128 * 0.7).length;
  ok("a capped field still reaches the far side", capped.length <= 130 && far > 0,
    capped.length + " plants, " + far + " of them past 70% of the square");
}

// --- Lineage 2: the floor of a carved room -------------------------------------------------------
//
// A subtractive brush hollows a room out, and the room has a floor: the brush's own bottom face,
// turned to face up. Only the horizontal ones are emitted - a vertical one is a wall, and a wall in
// the wrong place is an invisible barrier across a passage.
{
  const { interiors, hullsOf } = require("../src/lineage2/carve");
  const box = (brush, lo, hi) => {
    const f = [
      { n: [-1, 0, 0], v: [[lo[0], lo[1], lo[2]], [lo[0], hi[1], lo[2]], [lo[0], hi[1], hi[2]], [lo[0], lo[1], hi[2]]] },
      { n: [1, 0, 0], v: [[hi[0], lo[1], lo[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [hi[0], hi[1], lo[2]]] },
      { n: [0, -1, 0], v: [[lo[0], lo[1], lo[2]], [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], lo[1], lo[2]]] },
      { n: [0, 1, 0], v: [[lo[0], hi[1], lo[2]], [hi[0], hi[1], lo[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]] },
      { n: [0, 0, -1], v: [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]]] },
      { n: [0, 0, 1], v: [[lo[0], lo[1], hi[2]], [lo[0], hi[1], hi[2]], [hi[0], hi[1], hi[2]], [hi[0], lo[1], hi[2]]] },
    ];
    return f.map((x) => ({ brush, seq: brush, vertices: x.v, normal: x.n, polyFlags: 0, base: x.v[0] }));
  };
  const carved = box(0, [0, 0, 0], [512, 512, 256]).concat(box(1, [512, 0, 0], [1024, 512, 256]));
  const r = interiors(carved, [], hullsOf(carved), [], {});
  ok("a carved room gets a floor and a ceiling, and no walls", r.faces === 4 && r.upright === 8,
    r.faces + " flat, " + r.upright + " upright left off");
  ok("the room is seen from inside it", r.polys.every((q) => Math.abs(q.normal[2]) > 0.5) &&
    r.polys.filter((q) => q.normal[2] > 0).length === 2, "two floors up, two ceilings down");
  // The brush that hollows out the universe is not a room - it would floor the whole world.
  const world = box(2, [-400000, -400000, -16384], [400000, 400000, 16384]);
  const both = interiors(carved.concat(world), [], hullsOf(carved.concat(world)), [], {});
  ok("the brush that hollows out the world is not a room", both.faces === 4, both.faces + " flat faces with it in");
  // Rock put back over a floor buries it.
  const rock = box(3, [0, 0, -64], [512, 512, 64]);
  const buried = interiors(box(0, [0, 0, 0], [512, 512, 256]), hullsOf(rock), hullsOf(box(0, [0, 0, 0], [512, 512, 256])), [], {});
  ok("a floor buried in an additive brush is not drawn", buried.faces === 1, buried.faces + " flat face(s), the ceiling");

  // Scale. Lineage 2 is the one route the two engines do not bracket: its own MAXSTEPHEIGHT is 10
  // against Killing Floor's 35, and the client's standard building door (Door_Set_S/H_Door_OP_01)
  // is 37 x 82 - wide enough that the clearances hold anywhere in between. So the default is
  // character parity, 100/46, and what is worth asserting is that it stays inside the window.
  const l2convert = require("../src/lineage2/convert");
  ok("the default scale keeps a Lineage 2 step climbable in Killing Floor",
    l2convert.DEFAULTS.scale * 10 <= 35,
    "10 x " + l2convert.DEFAULTS.scale + " = " + (10 * l2convert.DEFAULTS.scale).toFixed(2) + " uu, limit 35");
  ok("the default scale walks a specimen through a Lineage 2 door",
    l2convert.DEFAULTS.scale * 37 >= 52,
    "37 x " + l2convert.DEFAULTS.scale + " = " + (37 * l2convert.DEFAULTS.scale).toFixed(2) + " uu, specimen 52 wide");
}
console.log("\nQuake 3: archives, BSP, shaders, images");
{
  const { installedQuake3 } = require("../src/resources");
  const { GameFs, searchDirs } = require("../src/quake3/pk3");
  const Q3 = require("../src/quake3/bsp");
  const { parseShaders, ShaderSet } = require("../src/quake3/shader");
  const image = require("../src/quake3/image");
  const q3convert = require("../src/quake3/convert");
  const { verify } = require("../src/verify");

  const Q3_DIR = installedQuake3()[0] || "";
  ok("a Quake III Arena install was found", !!Q3_DIR, Q3_DIR || "set KF_QUAKE3 to the folder holding baseq3\\");

  // The one check that needs no game files: the parser bug that cost most of a stock map's shaders.
  // `blendFunc GL_add` is a one-word blend spelled like a two-word one - id's own typo in
  // sfx.shader - and consuming a second token for it swallowed the stage's closing brace, which
  // desynced every shader after it in the file.
  {
    const text = 'textures/a/one\n{\n{\nmap x.tga\nblendFunc GL_add\n}\n}\ntextures/a/two\n{\nqer_editorimage y.tga\n}\n';
    const sh = parseShaders(text);
    ok("a one-word blendFunc does not swallow the stage's closing brace",
      sh.size === 2 && sh.has("textures/a/two"), sh.size + " shader(s): " + [...sh.keys()].join(" "));
    ok("a stage's image is read", (sh.get("textures/a/one").stages[0] || {}).map === "x.tga");
    ok("an alphaFunc stage is a cut-out",
      parseShaders("t/x\n{\n{\nmap a.tga\nalphaFunc GE128\n}\n}\n").get("t/x").stages[0].alphaFunc === "GE128");
    // id writes its blend factors in CAPITALS. Matching only lowercase read every
    // `blendFunc GL_ONE GL_ONE` as the one-word form and called it opaque, which is how every
    // additive sprite in the game - the flames, the lamp glows, the portals - came across as a
    // rectangle of solid black.
    const add = parseShaders("t/a\n{\n{\nmap f.tga\nblendFunc GL_ONE GL_ONE\n}\n}\n").get("t/a");
    ok("an upper-case additive blendFunc is additive", add.stages[0].blend === "additive",
      "blend = " + add.stages[0].blend);
    // A terrain shader paints a second texture over the first and blends the two by the vertex
    // alpha. Both layers have to be found, or a Team Arena hillside is one flat rock.
    {
      const text = "textures/terrain/x_0to1\n{\n{\nmap rock1.tga\nrgbGen vertex\nalphaGen vertex\ntcmod scale 0.125 0.125\n}\n" +
        "{\nmap rock2.tga\nrgbGen vertex\nalphaGen vertex\ntcmod scale 0.25 0.25\nblendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA\n}\n}\n";
      const set = parseShaders(text);
      const sh2 = set.get("textures/terrain/x_0to1");
      const gamefs = { has: (p) => /rock[12]\.tga$/.test(p) };
      const { ShaderSet: SS } = require("../src/quake3/shader");
      const holder = Object.create(SS.prototype);
      holder.shaders = set;
      const r = holder.resolve("textures/terrain/x_0to1", gamefs);
      ok("a terrain shader's second layer and both UV scales are found",
        r.file === "rock1.tga" && r.tcScale && r.tcScale[0] === 0.125 &&
        r.overlay && r.overlay.file === "rock2.tga" && r.overlay.tcScale[0] === 0.25,
        r.file + " @" + (r.tcScale || []).join("x") + " + " + (r.overlay ? r.overlay.file + " @" + r.overlay.tcScale.join("x") : "nothing"));
      ok("...and the blend stage is the one carrying alphaGen vertex",
        sh2.stages[1].alphaGen === "vertex" && sh2.stages[1].blend === "blend");
    }
    // A flipbook keeps every frame, not just the first: Killing Floor plays them through AnimNext.
    const anim = parseShaders("t/b\n{\n{\nanimMap 10 a.tga b.tga c.tga\nblendFunc GL_ONE GL_ONE\n}\n}\n").get("t/b");
    ok("animMap keeps its frames and its rate",
      anim.stages[0].frames && anim.stages[0].frames.length === 3 && anim.stages[0].fps === 10 &&
      anim.stages[0].blend === "additive",
      (anim.stages[0].frames || []).join(",") + " @ " + anim.stages[0].fps + " fps, " + anim.stages[0].blend);
  }

  if (Q3_DIR) {
    const fsys = new GameFs(searchDirs(Q3_DIR, "baseq3"));
    const maps = fsys.list(/^maps\/.*\.bsp$/).sort();
    ok("the client's .pk3 archives read", maps.length >= 30 && fsys.list(/^scripts\/.*\.shader$/).length >= 20,
      maps.length + " maps, " + fsys.list(/^scripts\/.*\.shader$/).length + " shader scripts, " + fsys.index.size + " files");

    const map = new Q3.Bsp(fsys.read("maps/q3dm1.bsp"), "q3dm1");
    ok("q3dm1 is IBSP v46", map.version === 46, "version " + map.version);
    ok("the lightmap lump is a whole number of 128x128 pages",
      map.lumps[Q3.LUMP.LIGHTMAPS].len === map.lightmapCount * Q3.LIGHTMAP_SIZE * Q3.LIGHTMAP_SIZE * 3,
      map.lightmapCount + " pages");

    // Every face has to index inside the lumps it points at, or the mesh builder reads garbage.
    let badRange = 0, badLm = 0;
    for (const f of map.faces) {
      if (f.vertex < 0 || f.vertex + f.nVertexes > map.vertexCount) badRange++;
      if (f.meshvert < 0 || f.meshvert + f.nMeshverts > map.meshverts.length) badRange++;
      if (f.lmIndex >= map.lightmapCount) badLm++;
      for (let i = 0; i < f.nMeshverts; i++) {
        if (f.vertex + map.meshverts[f.meshvert + i] >= map.vertexCount) { badRange++; break; }
      }
    }
    ok("every face indexes inside the vertex and meshvert lumps", badRange === 0, badRange + " bad of " + map.faces.length);
    ok("every face's lightmap index is in range", badLm === 0, badLm + " bad");

    // A bezier patch lies inside the convex hull of its control points, and its corners ARE control
    // points. Both hold for any tessellation level, which is what makes them worth asserting.
    {
      const patch = map.faces.find((f) => f.type === Q3.FACE.PATCH);
      const ctrl = [];
      for (let i = 0; i < patch.nVertexes; i++) ctrl.push(map.vertex(patch.vertex + i).pos);
      const lo = [0, 1, 2].map((k) => Math.min(...ctrl.map((p) => p[k])));
      const hi = [0, 1, 2].map((k) => Math.max(...ctrl.map((p) => p[k])));
      const t = Q3.tessellatePatch(map, patch, 4);
      const outside = t.verts.filter((v) => [0, 1, 2].some((k) => v.pos[k] < lo[k] - 0.01 || v.pos[k] > hi[k] + 0.01));
      ok("a tessellated patch stays inside its control hull", outside.length === 0,
        t.verts.length + " vertices, " + outside.length + " outside");
      const corner = t.verts[0].pos, c0 = ctrl[0];
      ok("a patch's first corner is its first control point",
        [0, 1, 2].every((k) => Math.abs(corner[k] - c0[k]) < 0.01), corner.map(Math.round).join(","));
      ok("tessellation level n gives (n+1)^2 vertices per sub-patch",
        t.verts.length === ((patch.size[0] - 1) / 2) * ((patch.size[1] - 1) / 2) * 25,
        patch.size.join("x") + " control points -> " + t.verts.length + " vertices");
    }

    // Every surface a stock map draws has to end up with a picture, or the map converts to magenta.
    {
      const shaders = new ShaderSet(fsys);
      let used = 0, resolved = 0;
      const missing = [];
      for (const m of maps) {
        let b;
        try { b = new Q3.Bsp(fsys.read(m), m); } catch (e) { continue; }
        const seen = new Set();
        for (const f of b.faces) seen.add(f.texture);
        for (const i of seen) {
          const t = b.textures[i];
          if (!t || t.tool) continue;
          used++;
          const r = shaders.resolve(t.name, fsys);
          // A fog volume has no picture by design; the sky is a cube of its own.
          if (r.file || r.kind === "sky" || (r.shader && r.shader.params.has("fog"))) resolved++;
          else if (missing.length < 8) missing.push(t.name);
        }
      }
      ok("every stock surface shader resolves to an image, a sky or a fog volume",
        resolved === used, resolved + "/" + used + (missing.length ? " missing: " + missing.join(" ") : ""));
    }

    // Both image formats, against the sizes their own headers declare.
    {
      const one = (re) => fsys.list(re).find((f) => /^textures\//.test(f));
      let jpgOk = 0, tgaOk = 0, tried = 0;
      for (const f of [one(/\.jpg$/), one(/\.tga$/)].filter(Boolean)) {
        tried++;
        const buf = fsys.read(f);
        const im = image.decode(f, buf);
        const w = /\.tga$/.test(f) ? buf.readUInt16LE(12) : null;
        const good = im.width > 0 && im.height > 0 && im.rgb.length === im.width * im.height * 3 &&
          (w === null || w === im.width);
        if (/\.jpg$/.test(f)) jpgOk += good ? 1 : 0; else tgaOk += good ? 1 : 0;
      }
      ok("a .jpg and a .tga decode to their declared size", tried === 2 && jpgOk === 1 && tgaOk === 1,
        "jpg " + jpgOk + ", tga " + tgaOk);
      // A synthetic 32-bit TGA, top-down, so the pixel order is checked and not just the size.
      const head = Buffer.alloc(18);
      head[2] = 2; head.writeUInt16LE(2, 12); head.writeUInt16LE(1, 14); head[16] = 32; head[17] = 0x20;
      const body = Buffer.from([10, 20, 30, 40, 50, 60, 70, 80]);        // BGRA, BGRA
      const t = image.decodeTga(Buffer.concat([head, body]));
      ok("TGA is BGRA on disk and RGB out", t.rgb[0] === 30 && t.rgb[1] === 20 && t.rgb[2] === 10 && t.alpha[0] === 40,
        [t.rgb[0], t.rgb[1], t.rgb[2], t.alpha[0]].join(","));
    }
    fsys.close();

    // A Quake 3 unit against Killing Floor's own physics: the engine's MaxStepHeight is 35 Unreal
    // units and Quake 3's STEPSIZE is 18 map units, so a scale over 35/18 makes a stock staircase
    // unclimbable and cuts the player off from half of q3dm7.
    ok("the default scale keeps a Quake 3 step climbable in Killing Floor",
      q3convert.DEFAULTS.scale * 18 <= 35, "18 x " + q3convert.DEFAULTS.scale + " = " + (18 * q3convert.DEFAULTS.scale) + " uu, limit 35");

    // And the floor under it: a Quake 3 player is 56 units tall (playerMaxs[2] 32 over MINS_Z -24),
    // so the tightest passage a mapper may build is 56 and KFHumanPawn's 100 has to come through it.
    ok("the default scale fits the Killing Floor pawn through a Quake 3 passage",
      q3convert.DEFAULTS.scale * 56 >= 100,
      "56 x " + q3convert.DEFAULTS.scale + " = " + (56 * q3convert.DEFAULTS.scale).toFixed(2) + " uu, pawn 100");

    // End to end: one map, written and read back by the independent verifier.
    {
      const out = path.join(require("os").tmpdir(), "kfmi-q3dm1-selfcheck.rom");
      const res = q3convert.convert({ clientDir: Q3_DIR, map: "q3dm1", outFile: out, log: () => { } });
      const v = verify(res.out);
      const failed = v.report.split("\n").filter((l) => /^\s*FAIL/.test(l));
      ok("q3dm1 converts and passes every invariant of the finished .rom", v.ok,
        (res.size / 1048576).toFixed(2) + " MB, " + res.stats.triangles + " triangles, " +
        res.lightmapPages + " lightmap pages" + (failed.length ? " -> " + failed[0].trim() : ""));
      try { fs.unlinkSync(out); } catch (e) { /* left behind on a locked filesystem */ }
    }
  }
}

console.log("\nTactical Ops: UE1 packages, the model, the shadow bits");
{
  const { installedTacticalOps } = require("../src/resources");
  const TO = require("../src/tacticalops/package");
  const toModel = require("../src/tacticalops/model");
  const toConvert = require("../src/tacticalops/convert");
  const { verify } = require("../src/verify");

  // Two checks that need no game files, and both of them are crashes that reached the client.
  //
  // A block-compressed level needs ceil(w/4)*ceil(h/4) blocks, rounding up in each dimension on its
  // own: a 16x2 is FOUR blocks, not the one that "smaller than 4x4" reasoning gives it. D3D works
  // the count out itself and refuses the texture - "CreateTexture failed(D3DERR_INVALIDCALL)" -
  // taking the frame with it. See GOTCHAS 1.9.
  {
    const rgb = Buffer.alloc(16 * 2 * 3, 128);
    ok("a DXT1 level short in one dimension is still whole blocks",
      dxt.encodeDXT1(rgb, 16, 2).length === 4 * 8, dxt.encodeDXT1(rgb, 16, 2).length + " bytes for 16x2, want 32");
    ok("a DXT1 level smaller than a block is one block",
      dxt.encodeDXT1(Buffer.alloc(2 * 2 * 3), 2, 2).length === 8);
  }
  // ...and a block format cannot hold the BASE level of a texture smaller than one block at all, so
  // those have to go out uncompressed (GOTCHAS 5.16's neighbour: three stock maps carry a 2x2).
  {
    const { Package, RF } = require("../src/unreal/package");
    const { addRgbTexture } = require("../src/unreal/texture");
    const pkg = new Package({});
    const refs = {
      Texture: pkg.importClass("Engine", "Texture"), Palette: pkg.importClass("Engine", "Palette"),
      flagsGame: RF.Public | RF.Standalone | RF.LoadForClient | RF.LoadForServer | RF.LoadForEdit,
    };
    addRgbTexture(pkg, refs, "tiny", { width: 2, height: 2, rgb: Buffer.alloc(2 * 2 * 3, 200) }, 1, { wrap: true });
    addRgbTexture(pkg, refs, "big", { width: 8, height: 8, rgb: Buffer.alloc(8 * 8 * 3, 200) }, 1, { wrap: true });
    const back = R.parsePackage(pkg.build());
    const formatOf = (name) => {
      const e = back.exports.find((x) => x.name === name);
      const r = new R.Rd(back.buf, e.serialOffset);
      let format = -1;
      for (let g = 0; g < 32; g++) {
        const n = back.names[r.cidx()];
        if (n === undefined || n === "None") break;
        const info = r.u8(), type = info & 0x0f, sc = (info >> 4) & 7;
        if (type === 10) r.cidx();
        let size = [1, 2, 4, 12, 16][sc];
        if (sc === 5) size = r.u8(); else if (sc === 6) size = r.u16(); else if (sc === 7) size = r.u32();
        if ((info & 0x80) && type !== 3) r.u8();
        if (type === 3) continue;
        if (n === "Format") format = back.buf[r.pos];
        r.pos += size;
      }
      return format;
    };
    ok("a texture smaller than one block is written uncompressed", formatOf("tiny") === 5, "format " + formatOf("tiny"));
    ok("an ordinary texture still goes out block-compressed", formatOf("big") === 3, "format " + formatOf("big"));
  }
  // The indexed writer (the GoldSrc route's own) has the same trap in it, so it gets the same check:
  // a non-square texture's tail levels go flat, and every one of them must still hold whole blocks.
  {
    const { Package, RF } = require("../src/unreal/package");
    const { addTexture } = require("../src/unreal/texture");
    const pkg = new Package({});
    const refs = {
      Texture: pkg.importClass("Engine", "Texture"), Palette: pkg.importClass("Engine", "Palette"),
      flagsGame: RF.Public | RF.Standalone | RF.LoadForClient | RF.LoadForServer | RF.LoadForEdit,
    };
    addTexture(pkg, refs, {
      name: "strip", width: 16, height: 2,
      mips: [{ width: 16, height: 2, data: Buffer.alloc(32, 7) }],
      palette: Buffer.alloc(768, 128),
    }, { dxt: true });
    const back = R.parsePackage(pkg.build());
    const e = back.exports.find((x) => x.name === "strip");
    const r = new R.Rd(back.buf, e.serialOffset);
    for (let g = 0; g < 32; g++) {
      const n = back.names[r.cidx()];
      if (n === undefined || n === "None") break;
      const info = r.u8(), type = info & 0x0f, sc = (info >> 4) & 7;
      if (type === 10) r.cidx();
      let size = [1, 2, 4, 12, 16][sc];
      if (sc === 5) size = r.u8(); else if (sc === 6) size = r.u16(); else if (sc === 7) size = r.u32();
      if ((info & 0x80) && type !== 3) r.u8();
      if (type !== 3) r.pos += size;
    }
    const count = r.cidx();
    let wrong = 0, first = "";
    for (let i = 0; i < count; i++) {
      r.i32();
      const len = r.cidx();
      r.skip(len);
      const w = r.i32(), h = r.i32();
      r.u8(); r.u8();
      const want = Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * 16;   // DXT3
      if (len !== want && !first) { wrong++; first = w + "x" + h + " has " + len + ", wants " + want; }
    }
    ok("the indexed writer's levels hold whole blocks too", wrong === 0 && count === 5,
      count + " level(s) for 16x2" + (first ? ", " + first : ""));
  }
  // The luxel grid is read through the dual basis of the surface's two texture axes - they are
  // neither unit length nor guaranteed orthogonal - and the light's colour through Unreal's byte
  // hue/saturation, where saturation is INVERTED: 255 is white, 0 is the pure hue.
  {
    const { dualBasis, hsvToRgb } = require("../src/tacticalops/light");
    const d = dualBasis([2, 0, 0], [0, 3, 0], [0, 0, 1]);
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    ok("the dual basis inverts the texture axes", near(d.u[0], 0.5) && near(d.v[1], 1 / 3),
      "u " + d.u.map((v) => +v.toFixed(3)).join(",") + " v " + d.v.map((v) => +v.toFixed(3)).join(","));
    const turned = dualBasis([1, 1, 0], [-1, 1, 0], [0, 0, 1]);
    ok("...and follows them when they are turned", near(turned.u[0], 0.5) && near(turned.u[1], 0.5),
      turned.u.map((v) => +v.toFixed(3)).join(","));
    ok("light saturation 255 is white and 0 is the pure hue",
      hsvToRgb(0, 255).every((c) => c === 1) && hsvToRgb(0, 0).join() === "1,0,0" &&
      hsvToRgb(85, 0).map((c) => Math.round(c)).join() === "0,1,0");
  }
  // UE1 translucency is the texel's BRIGHTNESS, and that figure has to reach Killing Floor as an
  // alpha channel or a dark pane comes out as a slab of black (TO-Resurrection's museum cases).
  {
    const { topAsRgba } = require("../src/tacticalops/texture");
    const palette = Buffer.alloc(256 * 3);
    palette[0] = 0; palette[1] = 0; palette[2] = 0;               // index 0: black
    palette[3] = 255; palette[4] = 255; palette[5] = 255;         // index 1: white
    const tex = {
      format: 0, width: 2, height: 1, palette,
      mips: [{ data: Buffer.from([0, 1]), width: 2, height: 1 }],
    };
    const luma = topAsRgba(tex, "luma");
    const mask = topAsRgba(tex, "mask");
    ok("a translucent surface's alpha is the texel's own brightness",
      luma && luma.alpha[0] === 0 && luma.alpha[1] === 255,
      luma ? "alpha " + luma.alpha[0] + "," + luma.alpha[1] : "no pixels");
    ok("...and a cut-out still masks on palette index 0",
      mask && mask.alpha[0] === 0 && mask.alpha[1] === 255);
  }

  // The scale ceiling, from the two engines' own constants: UE1's Pawn.MaxStepHeight is 25 and
  // UE2.5's MAXSTEPHEIGHT is 35, so anything above 1.4 makes a stock staircase unclimbable.
  ok("the default scale keeps a Tactical Ops step climbable in Killing Floor",
    toConvert.DEFAULTS.scale * 25 <= 35,
    "25 x " + toConvert.DEFAULTS.scale + " = " + (25 * toConvert.DEFAULTS.scale) + " uu, limit 35");

  // And the floor under it: TournamentPlayer is CollisionHeight 39, so a Tactical Ops player is 78
  // units tall and the tightest passage built for him has to take KFHumanPawn's 100.
  ok("the default scale fits the Killing Floor pawn through a Tactical Ops passage",
    toConvert.DEFAULTS.scale * 78 >= 100,
    "78 x " + toConvert.DEFAULTS.scale + " = " + (78 * toConvert.DEFAULTS.scale).toFixed(2) + " uu, pawn 100");

  // A UE1 node's ring winds the opposite way round from what a UE2.5 static mesh wants: emitted as
  // stored, every surface faces away and the client draws the level inside out - the "shredded"
  // frames TO-Blaze-of-Glory came back with. One square, wound counter-clockwise seen from +Z, has
  // to come out facing -Z.
  {
    const { buildMeshes } = require("../src/tacticalops/mesh");
    const square = [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]];
    const model = {
      points: square, vectors: [[1, 0, 0], [0, 1, 0]],
      verts: square.map((_, i) => ({ pVertex: i })),
      nodes: [{ numVertices: 4, iSurf: 0, iVertPool: 0, iZone: [0, 0] }],
      surfs: [{ pBase: 0, vTextureU: 0, vTextureV: 1, panU: 0, panV: 0, polyFlags: 0, material: 1 }],
    };
    const built = buildMeshes(model, { scale: 1, texOf: () => ({ ref: 1, kind: "opaque", origWidth: 64, origHeight: 64 }) });
    const m = built.meshes[0];
    const p = [0, 1, 2].map((k) => m.vertices[m.indices[k]].pos);
    const e1 = [0, 1, 2].map((k) => p[1][k] - p[0][k]);
    const e2 = [0, 1, 2].map((k) => p[2][k] - p[0][k]);
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    ok("a node ring comes out wound against the way UE1 stored it",
      built.meshes.length === 1 && nz < 0 && m.vertices[0].normal[2] < 0,
      "winding normal z " + nz + ", vertex normal " + m.vertices[0].normal.join(","));
  }

  const TO_DIR = installedTacticalOps()[0] || "";
  ok("a Tactical Ops install was found", !!TO_DIR, TO_DIR || "set KF_TACTICALOPS to the folder holding TacticalOps\\Maps");

  if (TO_DIR) {
    const client = new TO.Client(TO_DIR);
    const maps = client.maps();
    ok("the client's packages index", maps.length >= 30 && client.has("engine"),
      maps.length + " TO-* maps, " + client.byName.size + " packages");

    // The oracle for the whole UE1 reader: the walk has to land exactly on the object's end.
    let walked = 0, off = 0, first = "";
    for (const m of maps) {
      const pkg = TO.load(m.file);
      try { toModel.readModel(pkg, toModel.findWorldModel(pkg)); walked++; }
      catch (e) { off++; if (!first) first = m.name + ": " + e.message; }
    }
    ok("every stock map's world model walks to the byte", off === 0, walked + " maps" + (off ? ", " + off + " off: " + first : ""));

    {
      const pkg = TO.load(client.pathOf("TO-Crossfire"));
      const model = toModel.readModel(pkg, toModel.findWorldModel(pkg));

      // UE1's baked light is one bit per luxel per light, run end to end from DataOffset. Summing
      // what every surface needs must account for LightBits exactly, or the runs are being read at
      // the wrong stride and every shadow lands on the wrong surface.
      let need = 0;
      const seen = new Set();
      for (const s of model.surfs) {
        if (s.iLightMap < 0 || seen.has(s.iLightMap)) continue;
        seen.add(s.iLightMap);
        const lm = model.lightMap[s.iLightMap];
        if (!lm) continue;
        let lights = 0;
        for (let i = lm.iLightActors; i >= 0 && i < model.lights.length && model.lights[i]; i++) lights++;
        need += ((lm.uClamp + 7) >> 3) * lm.vClamp * lights;
      }
      ok("the shadow bit runs account for LightBits to the byte", need === model.lightBits.length,
        need + " needed, " + model.lightBits.length + " stored");

      // ...and the luxel grid has to be the surface's own: every vertex of every node must land
      // inside its block under u = ((P - Base) . TextureU - Pan.X) / UScale.
      let inside = 0, outside = 0;
      for (const node of model.nodes) {
        if (node.numVertices < 3) continue;
        const surf = model.surfs[node.iSurf];
        if (!surf || surf.iLightMap < 0) continue;
        const lm = model.lightMap[surf.iLightMap];
        const O = model.points[surf.pBase], U = model.vectors[surf.vTextureU], V = model.vectors[surf.vTextureV];
        if (!lm || !O || !U || !V) continue;
        for (const p of toModel.nodePoints(model, node)) {
          const rel = [p[0] - O[0], p[1] - O[1], p[2] - O[2]];
          const u = ((rel[0] * U[0] + rel[1] * U[1] + rel[2] * U[2]) - lm.pan[0]) / lm.uScale;
          const v = ((rel[0] * V[0] + rel[1] * V[1] + rel[2] * V[2]) - lm.pan[1]) / lm.vScale;
          if (u >= -0.5 && v >= -0.5 && u <= lm.uClamp - 0.5 && v <= lm.vClamp - 0.5) inside++; else outside++;
        }
      }
      ok("every node vertex lands inside its own light mesh", outside === 0, inside + " inside, " + outside + " outside");

      // A cut-out is the texture's own answer as often as the surface's: UT99 ORs a bMasked
      // texture's PF_Masked into the surface flags at draw time (TO.9). Read the surface flag alone
      // and TO-Crossfire's bridge railings draw as solid black rectangles - all 54 of their
      // surfaces are on a bMasked texture and NONE of them carries the flag.
      {
        const toTex = require("../src/tacticalops/texture");
        let flagged = 0, textureOnly = 0;
        for (const s of model.surfs) {
          if (!s.material) continue;
          const hit = TO.resolveRef(pkg, s.material, client, (c) => /Texture$/.test(c));
          if (!hit) continue;
          let t;
          try { t = toTex.readTexture(hit.pkg, hit.exp); } catch (e) { continue; }
          if (!t.masked) continue;
          if (s.polyFlags & toModel.PF.Masked) flagged++; else textureOnly++;
        }
        ok("a cut-out the surface does not declare is found on the texture", textureOnly > 0,
          textureOnly + " surface(s) masked by the texture alone, " + flagged + " by the flag");
      }

      // Water is a WetTexture: a program that distorts a still image, shipping the empty buffer it
      // writes into. The still image is the SourceTexture, and carrying it is what makes the canal
      // read as water rather than one flat colour.
      {
        const toTex = require("../src/tacticalops/texture");
        const hit = TO.resolveRef(pkg, model.surfs.find((s) => {
          if (!s.material) return false;
          const h = TO.resolveRef(pkg, s.material, client, (c) => /Texture$/.test(c));
          return !!h && h.pkg.classOf(h.exp) === "WetTexture";
        }).material, client, (c) => /Texture$/.test(c));
        const wet = toTex.readTexture(hit.pkg, hit.exp);
        const still = wet.sourceTexture ? TO.resolveRef(hit.pkg, wet.sourceTexture, client, (c) => /Texture$/.test(c)) : null;
        ok("a WetTexture names the still image it distorts",
          hit.pkg.classOf(hit.exp) === "WetTexture" && !!still && still.exp.name !== hit.exp.name,
          hit.exp.name + " -> " + (still ? still.exp.name : "nothing"));
      }

      // A mover's geometry is its brush's UPolys, and 71 of the 400 in the stock maps carry a script
      // state frame in front of them.
      const { readMovers } = require("../src/tacticalops/movers");
      const mv = readMovers(pkg, { scale: 1.3, materialFor: () => ({ ref: 1, origWidth: 256, origHeight: 256 }) });
      ok("a map's movers read their brush polygons", mv.stats.failed === 0 && mv.movers.length > 0,
        mv.movers.length + " movers, " + mv.stats.polys + " polygons, " + mv.stats.failed + " unreadable");

      // A mover has to obey the same winding rule as the world (TO.4), and a door that does not is
      // a door you see straight through from the corridor it closes. A mover brush is a solid, its
      // mesh is centred on its own box, so a correctly wound triangle's right-hand normal points
      // back INTO the brush. Thin and L-shaped brushes make that a majority rather than a rule -
      // measured 120/26, 899/79 and 782/342 on Spynet, TerrorMansion and Crossfire, and those
      // numbers swap the moment the winding is inverted.
      let inward = 0, outward = 0;
      for (const m of mv.movers) {
        const mesh = m.mesh;
        for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
          const p = [0, 1, 2].map((k) => mesh.vertices[mesh.indices[i + k]].pos);
          const e1 = [0, 1, 2].map((k) => p[1][k] - p[0][k]);
          const e2 = [0, 1, 2].map((k) => p[2][k] - p[0][k]);
          const c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
          const mid = [0, 1, 2].map((k) => (p[0][k] + p[1][k] + p[2][k]) / 3);
          if (c[0] * mid[0] + c[1] * mid[1] + c[2] * mid[2] < 0) inward++; else outward++;
        }
      }
      ok("a mover's triangles wind into the brush, like the world's nodes",
        inward + outward > 0 && inward > 2 * outward, inward + " inward, " + outward + " outward");
    }

    // End to end: one map, written and read back by the independent verifier.
    {
      const out = path.join(require("os").tmpdir(), "kfmi-to-selfcheck.rom");
      const res = toConvert.convert({ clientDir: TO_DIR, map: "TO-Crossfire", outFile: out, log: () => { } });
      const v = verify(res.out);
      const failed = v.report.split("\n").filter((l) => /^\s*FAIL/.test(l));
      ok("TO-Crossfire converts and passes every invariant of the finished .rom", v.ok,
        (res.size / 1048576).toFixed(2) + " MB, " + Math.round(res.stats.triangles) + " triangles, " +
        res.lightmapPages + " lightmap page(s)" + (failed.length ? " -> " + failed[0].trim() : ""));
      try { fs.unlinkSync(out); } catch (e) { /* left behind on a locked filesystem */ }
    }
  }
}

// --- what a play-test found: brush entities, shader stages, the lightmap atlas -------------------
console.log("\nBrush entities that draw nothing, and breakables nothing can shoot");
{
  const be = require("../src/build/brushents");
  ok("a trigger draws nothing", be.invisible({ classname: "trigger_hurt" }) &&
    be.invisible({ classname: "trigger_teleport" }) && be.invisible({ classname: "func_buyzone" }) &&
    be.invisible({ classname: "func_ladder" }));
  ok("...but a wall and an illusionary wall do",
    !be.invisible({ classname: "func_wall" }) && !be.invisible({ classname: "func_illusionary" }));

  const model = { mins: [0, 0, 0], maxs: [64, 64, 64], numfaces: 6 };
  const map = {
    models: [model, model, model],
    entities: [
      { classname: "func_breakable", model: "*1", health: "10", material: "4" },
      { classname: "func_breakable", model: "*2", health: "1", material: "1", spawnflags: "1" },
    ],
  };
  const got = be.collect(map);
  ok("a func_breakable the player can shoot becomes an actor", got.length === 1 && got[0].mi === 1,
    got.length + " of 2");
  ok("...and one flagged SF_BREAK_TRIGGER_ONLY stays world geometry",
    !got.some((s) => s.mi === 2));

  // A zone brush is a volume when the mapper drew it like one, and the room when he did not.
  ok("a buy zone in tool textures is a volume", be.invisible({ classname: "func_buyzone" }, true));
  ok("...and one the mapper textured is the room, and stays",
    !be.invisible({ classname: "func_buyzone" }, false) &&
    !be.invisible({ classname: "func_ladder" }, false));
  ok("a trigger draws nothing whatever is on it",
    be.invisible({ classname: "trigger_hurt" }, false));

  const texMap = {
    faces: [{ texinfo: 0 }, { texinfo: 1 }],
    texinfo: [{ miptex: 0 }, { miptex: 1 }],
    miptex: [{ kind: "tool" }, { kind: "normal" }],
  };
  ok("modelIsToolOnly sees a real texture among the tool ones",
    be.modelIsToolOnly(texMap, { firstface: 0, numfaces: 1 }) === true &&
    be.modelIsToolOnly(texMap, { firstface: 0, numfaces: 2 }) === false);
}

console.log("\nA .mdl prop takes the light it is handed");
{
  const { buildPropMesh } = require("../src/build/propmesh");
  const mdl = {
    parts: [{
      tex: { name: "t", width: 4, height: 4 },
      tris: [[{ pos: [0, 0, 0], uv: [0, 0] }, { pos: [8, 0, 0], uv: [1, 0] }, { pos: [0, 8, 0], uv: [0, 1] }]],
    }],
  };
  const built = buildPropMesh(mdl, { scale: 1, texRefOf: () => 7, light: [30, 40, 50] });
  // FColor is B, G, R, A on disk.
  ok("the vertex colours are the light the caller sampled, not a constant",
    built.colors.every((c) => c[0] === 50 && c[1] === 40 && c[2] === 30),
    JSON.stringify(built.colors[0]));
}

console.log("\nQuake 3 shader stages");
{
  const { parseShaders, diffuseStage } = require("../src/quake3/shader");
  const text = [
    "textures/a/shiny {",
    "  { map textures/effects/tinfx.tga  tcGen environment  rgbGen identity }",
    "  { map textures/a/shiny.tga  blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA }",
    "  { map $lightmap  blendFunc GL_DST_COLOR GL_ONE_MINUS_DST_ALPHA }",
    "}",
    "textures/a/lit {",
    "  { map $lightmap  rgbgen identity }",
    "  { map textures/a/lit.tga  blendFunc GL_DST_COLOR GL_SRC_ALPHA  alphaGen lightingSpecular }",
    "}",
    "textures/a/bulb {",
    "  cull disable",
    "  deformVertexes autoSprite2",
    "  { map textures/a/bulb.tga  blendFunc Add }",
    "}",
    "models/x/energy {",
    "  { map models/x/energy.tga  blendfunc GL_ONE GL_ONE  tcMod scroll 2.2 1.3 }",
    "}",
    "textures/a/pad {",
    "  { map textures/a/swirl.tga  blendFunc GL_ONE GL_ZERO  tcmod rotate 130 }",
    "  { map textures/a/fan.tga  blendFunc blend }",
    "  { map textures/a/core.tga  blendfunc Add }",
    "  { map textures/a/plate.tga  blendFunc blend }",
    "  { map $lightmap  blendFunc GL_DST_COLOR GL_ONE_MINUS_DST_ALPHA }",
    "}",
    "textures/a/deathfog {",
    "  surfaceparm trans",
    "  surfaceparm fog",
    "  fogparms ( .55 .11 .1 ) 256",
    "  { map textures/a/fogcloud.tga  blendfunc gl_dst_color gl_zero }",
    "}",
  ].join("\n");
  const sh = parseShaders(text);
  const gamefs = { has: (p) => /\.tga$/.test(p), read: () => Buffer.alloc(0) };
  const set = { get: (n) => sh.get(String(n).toLowerCase()) || null };
  Object.setPrototypeOf(set, require("../src/quake3/shader").ShaderSet.prototype);
  set.shaders = sh;

  const shiny = set.resolve("textures/a/shiny", gamefs);
  ok("a wall painted over an environment map draws the WALL", shiny.file === "textures/a/shiny.tga",
    String(shiny.file));
  ok("...stays opaque, because its first stage is", shiny.kind === "normal", shiny.kind);
  ok("...and carries the stage under it, to composite in",
    shiny.layers.length === 2 && shiny.layers[0].file === "textures/effects/tinfx.tga" &&
    shiny.layers[1].file === "textures/a/shiny.tga" && shiny.layers[1].blend === "blend",
    JSON.stringify(shiny.layers));

  const lit = set.resolve("textures/a/lit", gamefs);
  ok("GL_DST_COLOR GL_SRC_ALPHA is a filter, not a pane of glass", lit.kind === "normal", lit.kind);

  const bulb = set.resolve("textures/a/bulb", gamefs);
  ok("deformVertexes autoSprite marks a billboard", bulb.sprite === true && bulb.kind === "additive");

  const energy = set.resolve("models/x/energy", gamefs);
  ok("tcMod scroll is read, for the TexPanner", !!energy.scroll &&
    energy.scroll[0] === 2.2 && energy.scroll[1] === 1.3, JSON.stringify(energy.scroll));
  ok("diffuseStage without a name still takes the first drawing stage",
    diffuseStage(sh.get("models/x/energy")).map === "models/x/energy.tga");

  // Team Arena's jump pads: a metal plate with a round hole over a spinning swirl. Carrying the
  // bottom stage alone left the pad an orange SQUARE.
  const pad = set.resolve("textures/a/pad", gamefs);
  ok("every drawing stage of a jump pad is carried, in order, with its blend",
    pad.layers.length === 4 && pad.layers[0].blend === "opaque" &&
    pad.layers[1].blend === "blend" && pad.layers[2].blend === "additive" &&
    pad.layers[3].file === "textures/a/plate.tga" && pad.layers[3].blend === "blend",
    pad.layers.map((l) => l.blend).join(","));
  ok("...and $lightmap is not one of them", !pad.layers.some((l) => /\$/.test(l.file)));

  const fog = set.resolve("textures/a/deathfog", gamefs);
  ok("fogparms gives a fog volume its colour and depth",
    !!fog.fog && fog.fog.rgb.join(",") === "0.55,0.11,0.1" && fog.fog.depth === 256,
    JSON.stringify(fog.fog));
}

console.log("\nThe lightmap atlas' mip chain");
{
  const { mipChain } = require("../src/unreal/texture");
  // One 4x4 block of a known colour in the corner of an 8x8 page; the rest is the packer's gap.
  const w = 8, h = 8;
  const px = Buffer.alloc(w * h * 4);
  const cov = new Uint8Array(w * h);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const i = y * w + x;
    px[i * 4] = 200; px[i * 4 + 1] = 200; px[i * 4 + 2] = 200; px[i * 4 + 3] = 255;
    cov[i] = 1;
  }
  const plain = mipChain(px, w, h);
  const aware = mipChain(px, w, h, cov);
  // The last level is 1x1: it covers the block AND the three quarters of the page that are gap.
  const last = (c) => c[c.length - 1].data[0];
  ok("a black gap drags a block's colour down without the coverage mask",
    last(plain) < 120, "1x1 level = " + last(plain));
  ok("...and does not with it", last(aware) === 200, "1x1 level = " + last(aware));
  ok("the chain still reaches 1x1 either way",
    plain[plain.length - 1].width === 1 && aware[aware.length - 1].width === 1,
    plain.length + " levels");
}

console.log("\nDefaults");
{
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "convert.js"), "utf8");
  ok("the GoldSrc route lights a map from its own lightmap unless told otherwise",
    /includes\(o\.lighting\) \? o\.lighting : "lightmap"/.test(src));
  const html = fs.readFileSync(path.join(__dirname, "..", "electron", "renderer", "index.html"), "utf8");
  ok("...and so does the desktop app", /settings\.lighting \|\| "lightmap"/.test(html));
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
