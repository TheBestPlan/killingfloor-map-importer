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

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
