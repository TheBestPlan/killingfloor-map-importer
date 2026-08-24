// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Project IGI map -> Killing Floor .rom. An IGI level's geometry is a set of .mef meshes packed in
// `missions/<location>/<level>/models/<level>.res` (ILFF/IRES), each already in world space. This
// reads every mesh, and hands the combined world triangles to the glTF route's builder - the same KF
// skeleton, auto-colour, spawn-drop and verify path the model and Source routes use. An IGI level is
// tens of thousands of units across, so the default scale auto-fits it to a walkable KF extent
// (override with --scale). A flat ground quad is laid at the typical building base so the player has
// ground under foot (--no-ground to skip): the real octree terrain (terrain/*.ctr+*.cmd) decodes but
// sits in a separate global frame with no decoded level->world transform, and it is near-flat anyway.
// Textures (in the level .mtp/.tex) are not carried yet; the shell is auto-coloured. See docs/games/igi.md.
"use strict";

const fs = require("fs");
const path = require("path");
const { readResPack } = require("./ilff");
const { readMef } = require("./mef");
const { readTex } = require("./tex");
const { readMtp } = require("./mtp");
const gltf = require("../gltf/convert");

const TARGET_EXTENT = 45000;   // fit the level's larger horizontal span to this many KF units
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const applyMat4 = (m, p) => [p[0], p[1], p[2]];
const applyMat3 = (m, n) => n;

// Accept the models .res directly, or a level folder / game root - find the largest models\*.res.
function findResFile(input) {
  if (/\.res$/i.test(input) && fs.existsSync(input)) return input;
  let best = null, bestSize = -1;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let names; try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const d of names) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p, depth + 1);
      else if (/\.res$/i.test(d.name) && /[\\/]models[\\/]/i.test(p)) { const s = fs.statSync(p).size; if (s > bestSize) { bestSize = s; best = p; } }
    }
  };
  walk(input, 0);
  if (!best) throw new Error("no models\\*.res found under " + input);
  return best;
}

function loadIgiScene(resFile, o, log) {
  const buf = fs.readFileSync(resFile);
  const entries = readResPack(buf);
  const meshes = [];
  let skipped = 0, templates = 0, tris = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const meshMinZ = [];
  const meshNames = [], meshModelIdx = [];

  // Textures: sibling textures/<level>.res holds LOOP .tex; the level .mtp (INST chunk) assigns, per model,
  // a texture list, and each render group's material index (@16 in the .mef) picks one - the exact original
  // mapping, decoded via mtp.js. Fallback (no .mtp) is a same-name/prefix guess. UVs come from XTRV @24.
  const materials = [{ name: "igi", alphaMode: "OPAQUE", imageIndex: null, factor: [0.6, 0.6, 0.6, 1] }];
  const texList = [null], texMatCache = new Map();
  let texEntries = null, mtp = null;
  if (o.textures !== false) {
    const texRes = resFile.replace(/models([\\/])/i, "textures$1");
    if (texRes !== resFile) { try { const tb = fs.readFileSync(texRes); texEntries = readResPack(tb).map((e) => ({ base: (e.name || "").replace(/^.*\//, "").replace(/\.tex$/i, "").toLowerCase(), buf: tb, off: e.offset, size: e.size })); } catch (e) { } }
    const mtpPath = path.join(path.dirname(path.dirname(resFile)), path.basename(resFile).replace(/\.res$/i, ".mtp"));
    try { mtp = readMtp(fs.readFileSync(mtpPath)); } catch (e) { }
  }
  // Exact texture name (with format suffix, e.g. glass_argb8888) -> a material index (decode + cache).
  const matForTexName = (name) => {
    if (!texEntries || !name) return 0;
    if (texMatCache.has(name)) return texMatCache.get(name);
    const ent = texEntries.find((e) => e.base === name);
    let mi = 0;
    if (ent) { let img = null; try { img = readTex(ent.buf.subarray(ent.off, ent.off + ent.size)); } catch (e) { } if (img) { mi = materials.length; materials.push({ name, alphaMode: img.alpha ? "MASK" : "OPAQUE", imageIndex: mi, factor: [1, 1, 1, 1] }); texList.push(img); } }
    texMatCache.set(name, mi); return mi;
  };
  // Same-name/prefix fallback for a model with no INST entry.
  const matForModel = (name) => {
    if (!texEntries || !name) return 0;
    let ent = texEntries.find((e) => e.base === name) || texEntries.find((e) => e.base.startsWith(name.replace(/_\d+$/, "") + "_"));
    return ent ? matForTexName(ent.base) : 0;
  };
  // A render group's texture material: INST[model][group.mat] -> TEXF name; else same-name fallback.
  const matForGroup = (modelIdx, groupMat, modelName) => {
    const list = mtp && mtp.texByModel[modelIdx];
    if (list && list[groupMat] !== undefined && mtp.texNames[list[groupMat]]) return matForTexName(mtp.texNames[list[groupMat]]);
    return matForModel(modelName);
  };

  const cand = [];
  for (let ei = 0; ei < entries.length; ei++) {
    const e = entries[ei];
    const m = readMef(buf, e.offset);
    if (!m) { skipped++; continue; }               // .res entry index == INST model_index (MODS order)
    const name = (e.name || "").replace(/^.*\//, "").replace(/\.mef$/i, "").toLowerCase();
    // A .mef is either a level mesh already placed in world space, or an OBJECT-SPACE template
    // (centred on the origin) that the level's compiled script (objects.qvm) instances elsewhere. The
    // templates have no placement here, so carried as-is they all stack at the origin into a giant
    // tangle - drop them (their bbox centre sits within its own extent of 0,0,0).
    const ml = [Infinity, Infinity, Infinity], mh = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.verts.length; i += 3) for (let k = 0; k < 3; k++) { const v = m.verts[i + k]; if (v < ml[k]) ml[k] = v; if (v > mh[k]) mh[k] = v; }
    const span = Math.max(mh[0] - ml[0], mh[1] - ml[1], mh[2] - ml[2]) || 1;
    const cDist = Math.hypot((ml[0] + mh[0]) / 2, (ml[1] + mh[1]) / 2, (ml[2] + mh[2]) / 2);
    if (cDist < span * 0.15) { templates++; continue; }
    cand.push({ m, ml, mh, name, modelIdx: ei });
  }
  if (!cand.length) throw new Error("no meshes decoded from " + path.basename(resFile));
  // Drop Z-outlier meshes: a handful of .mef meshes decode with vertices shot to absurd Z (60-80k while
  // the level proper sits near 0) - misparsed spikes that inflate the bounds, wreck the auto-fit centre
  // (the whole level ends up crammed at the bottom of a giant empty box), and render as stray shards.
  // Robust bound off the Z-centre distribution keeps the real level and drops the garbage.
  const zc = cand.map((c) => (c.ml[2] + c.mh[2]) / 2).slice().sort((a, b) => a - b);
  const med = zc[zc.length >> 1];
  const mad = zc.map((z) => Math.abs(z - med)).sort((a, b) => a - b)[zc.length >> 1] || 1;   // robust spread (survives many outliers)
  const bound = Math.max(mad * 6, 6000);
  const zLo = med - bound, zHi = med + bound;
  let zdrop = 0;
  for (const c of cand) {
    if ((c.ml[2] + c.mh[2]) / 2 < zLo || (c.ml[2] + c.mh[2]) / 2 > zHi) { zdrop++; continue; }
    for (let k = 0; k < 3; k++) { if (c.ml[k] < lo[k]) lo[k] = c.ml[k]; if (c.mh[k] > hi[k]) hi[k] = c.mh[k]; }
    meshes.push(c.m); meshNames.push(c.name); meshModelIdx.push(c.modelIdx); tris += c.m.tris.length; meshMinZ.push(c.ml[2]);
  }
  if (!meshes.length) throw new Error("no meshes left after Z-outlier drop from " + path.basename(resFile));
  if (zdrop) log("igi: dropped " + zdrop + " Z-outlier mesh(es) (misparsed spikes)");

  // Ground plane. The real outdoor terrain is an octree heightfield in the level's terrain/*.ctr+*.cmd
  // (decoded via the CTR/CMD cube-mesh format), but it lives in a separate global coordinate frame from
  // the world-space .mef geometry and the level->world transform is not decoded, so it cannot be aligned
  // to the buildings. That terrain is near-flat (height varies ~0.4% across the footprint), so a flat
  // ground quad at the typical building base gives correct "ground under feet". Disable with --no-ground.
  if (o.ground !== false) {
    const sortedZ = meshMinZ.slice().sort((a, b) => a - b);
    const groundZ = sortedZ[Math.floor(sortedZ.length * 0.25)];   // 25th percentile base = typical ground
    const mx = (hi[0] - lo[0]) * 0.08, my = (hi[1] - lo[1]) * 0.08;   // 8% margin past the buildings
    const x0 = lo[0] - mx, x1 = hi[0] + mx, y0 = lo[1] - my, y1 = hi[1] + my;
    // Finely subdivided so KF's pawn trace can't miss a single map-spanning triangle. FLAT: an earlier
    // Z-ripple was sized off the (outlier-inflated) Z span and became 110 KF-unit spikes that embedded and
    // instantly killed the pawn at spawn. KF collides flat floors fine (every stock map's floor is flat).
    const N = 64, verts = [], gtris = [];
    for (let iy = 0; iy <= N; iy++) for (let ix = 0; ix <= N; ix++) verts.push(x0 + (x1 - x0) * ix / N, y0 + (y1 - y0) * iy / N, groundZ);
    for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) {
      const a = iy * (N + 1) + ix, b = a + 1, c = a + (N + 1), d = c + 1;
      gtris.push([a, c, b], [b, c, d]);
    }
    meshes.push({ verts, tris: gtris }); meshNames.push(null); meshModelIdx.push(-1); tris += gtris.length;
  }

  // Auto-fit: scale the larger horizontal (X/Y) span to the target KF extent, unless --scale is given.
  const spanX = hi[0] - lo[0], spanY = hi[1] - lo[1];
  const scale = o.scale || (TARGET_EXTENT / Math.max(spanX, spanY, 1));
  const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2, cz = (lo[2] + hi[2]) / 2;
  log("igi: " + meshes.length + " meshes (" + Math.round(tris) + " triangles), world span " +
    Math.round(spanX) + "x" + Math.round(spanY) + "x" + Math.round(hi[2] - lo[2]) + " units, scale " + scale.toFixed(3) + (o.scale ? "" : " (auto-fit)") + (templates ? ", " + templates + " object templates dropped" : "") + (skipped ? ", " + skipped + " non-mesh skipped" : ""));

  // One prim per render GROUP: each group carries its own texture (INST[model][group.mat] -> TEXF), sharing
  // the mesh's vertex/UV buffer. Meshes without groups (the ground plane) fall back to a single flat prim.
  const prims = [];
  let texturedGroups = 0, totalGroups = 0;
  meshes.forEach((m, j) => {
    const n = m.verts.length / 3;
    const pos = new Float32Array(m.verts.length);
    for (let i = 0; i < n; i++) { pos[i * 3] = (m.verts[i * 3] - cx) * scale; pos[i * 3 + 1] = (m.verts[i * 3 + 1] - cy) * scale; pos[i * 3 + 2] = (m.verts[i * 3 + 2] - cz) * scale; }
    const uv = m.uvs ? { data: m.uvs } : null;
    for (const g of (m.groups || [{ mat: -1, tris: m.tris }])) {
      totalGroups++;
      const mat = g.mat >= 0 ? matForGroup(meshModelIdx[j], g.mat, meshNames[j]) : 0;
      if (mat) texturedGroups++;
      const indices = new Uint32Array(g.tris.length * 3);
      for (let i = 0; i < g.tris.length; i++) { indices[i * 3] = g.tris[i][0]; indices[i * 3 + 1] = g.tris[i][1]; indices[i * 3 + 2] = g.tris[i][2]; }
      prims.push({ matrix: IDENTITY, pos: { data: pos, count: n }, nrm: null, uv: mat ? uv : null, indices, material: mat });
    }
  });
  if (texEntries) log("igi: " + (materials.length - 1) + " textures on " + texturedGroups + "/" + totalGroups + " render groups");
  return { prims, materials, lights: [], applyMat4, applyMat3, decodeMaterialImage: (i) => texList[i], baseName: path.basename(resFile).replace(/\.res$/i, "") };
}

function convert(opts) {
  const o = Object.assign({}, opts);
  const log = o.log || (() => { });
  const resFile = findResFile(o.file);
  const scene = loadIgiScene(resFile, o, log);
  return gltf.convert(Object.assign({}, o, {
    scene, file: null, baseName: "IGI-" + scene.baseName, mapName: o.mapName,
    axes: [0, 1, 2], flip: [0, 1, 0], scale: 1,          // positions are already centred + scaled above
    autoColor: o.autoColor !== false,
    spawnClearance: true,   // IGI's centroid often sits in a wall/structure; pick a horizontally-clear floor so the pawn isn't spawned embedded (encroachment death)
    twoSided: o.twoSided !== false, groundUp: false,   // IGI faces are single-sided - two-side so nothing is see-through
    ambient: o.ambient !== undefined ? o.ambient : 44, glow: o.glow !== undefined ? o.glow : 24,
    cullDistance: o.cullDistance !== undefined ? o.cullDistance : +(process.env.KF_CULL_DIST || 12000),
    title: scene.baseName + " (Project IGI)",
  }));
}

module.exports = { convert, loadIgiScene, findResFile };
