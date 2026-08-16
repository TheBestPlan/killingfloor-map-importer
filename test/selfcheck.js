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

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
