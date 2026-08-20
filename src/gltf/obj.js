// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Wavefront OBJ (+ MTL) reader, producing the same scene shape as read.js loadScene:
//   { prims:[{pos,nrm,uv,indices,material,matrix}], materials:[{name,factor,imageIndex}],
//     lights:[], decodeMaterialImage, applyMat4, applyMat3 }
//
// OBJ is the common export from the model sites (Free3D, CGTrader, Open3DModel). No node transforms
// (everything is already world space) and no lights - just geometry + per-material texture.
"use strict";

const fs = require("fs");
const path = require("path");
const { decodeImage } = require("./read");

function parseMtl(file, log) {
  const mats = new Map();
  let cur = null;
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (log) log("  mtl: " + path.basename(file) + " not found"); return mats; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? "" : line.slice(sp + 1).trim();
    if (key === "newmtl") { cur = { name: val, factor: [1, 1, 1, 1], map: null }; mats.set(val, cur); }
    else if (!cur) continue;
    else if (key === "Kd") { const p = val.split(/\s+/).map(Number); cur.factor = [p[0] || 0, p[1] || 0, p[2] || 0, 1]; }
    else if (key === "map_Kd" || key === "map_Ka") { if (!cur.map) cur.map = val.split(/\s+/).pop(); }  // ignore option flags, take the filename
  }
  return mats;
}

function loadObj(file, log) {
  const dir = path.dirname(file);
  const text = fs.readFileSync(file, "utf8");
  const V = [], VT = [], VN = [];
  const mtlMats = new Map();
  // groups keyed by material name -> { verts:{pos,nrm,uv} de-duped, indices, key->idx }
  const groups = new Map();
  let curMatName = "__default";
  const groupOf = (name) => {
    let g = groups.get(name);
    if (!g) { g = { pos: [], nrm: [], uv: [], indices: [], key: new Map() }; groups.set(name, g); }
    return g;
  };

  const ref = (a, len) => { const i = parseInt(a, 10); return i < 0 ? len + i : i - 1; };   // OBJ is 1-based; negatives count from the end
  const cornerIndex = (g, token) => {
    let cached = g.key.get(token);
    if (cached !== undefined) return cached;
    const parts = token.split("/");
    const vi = ref(parts[0], V.length);
    const ti = parts[1] ? ref(parts[1], VT.length) : -1;
    const ni = parts[2] ? ref(parts[2], VN.length) : -1;
    const idx = g.pos.length / 3;
    const v = V[vi] || [0, 0, 0];
    g.pos.push(v[0], v[1], v[2]);
    const n = ni >= 0 ? VN[ni] : null;
    g.nrm.push(n ? n[0] : 0, n ? n[1] : 0, n ? n[2] : 1);
    const t = ti >= 0 ? VT[ti] : null;
    g.uv.push(t ? t[0] : 0, t ? (1 - t[1]) : 0);   // OBJ V is bottom-up; flip to match glTF/top-down
    g.key.set(token, idx);
    return idx;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? "" : line.slice(sp + 1).trim();
    if (key === "v") { const p = rest.split(/\s+/).map(Number); V.push([p[0], p[1], p[2]]); }
    else if (key === "vn") { const p = rest.split(/\s+/).map(Number); VN.push([p[0], p[1], p[2]]); }
    else if (key === "vt") { const p = rest.split(/\s+/).map(Number); VT.push([p[0], p[1] === undefined ? 0 : p[1]]); }
    else if (key === "usemtl") { curMatName = rest || "__default"; }
    else if (key === "mtllib") { for (const m of parseMtl(path.join(dir, rest), log)) mtlMats.set(m[0], m[1]); }
    else if (key === "f") {
      const toks = rest.split(/\s+/).filter(Boolean);
      const g = groupOf(curMatName);
      const c0 = cornerIndex(g, toks[0]);
      for (let i = 1; i + 1 < toks.length; i++) {   // triangle fan for polygons
        g.indices.push(c0, cornerIndex(g, toks[i]), cornerIndex(g, toks[i + 1]));
      }
    }
  }

  // Materials list + prims, indexed the same way the glTF path expects.
  const materials = [];
  const matIndex = new Map();
  const ensureMat = (name) => {
    if (matIndex.has(name)) return matIndex.get(name);
    const src = mtlMats.get(name);
    const idx = materials.length;
    materials.push({ name, factor: src ? src.factor : [1, 1, 1, 1], _map: src ? src.map : null, imageIndex: null });
    matIndex.set(name, idx);
    return idx;
  };
  const prims = [];
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const [name, g] of groups) {
    if (!g.pos.length) continue;
    const mi = ensureMat(name);
    materials[mi].imageIndex = materials[mi]._map ? mi : null;   // one image per material, keyed by material index
    prims.push({
      pos: { data: g.pos, count: g.pos.length / 3 }, nrm: { data: g.nrm, count: g.nrm.length / 3 },
      uv: { data: g.uv, count: g.uv.length / 2 }, indices: g.indices, material: mi, matrix: identity,
    });
  }

  const applyMat4 = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
  const applyMat3 = (m, n) => { const o = [m[0] * n[0] + m[4] * n[1] + m[8] * n[2], m[1] * n[0] + m[5] * n[1] + m[9] * n[2], m[2] * n[0] + m[6] * n[1] + m[10] * n[2]]; const len = Math.hypot(o[0], o[1], o[2]) || 1; return [o[0] / len, o[1] / len, o[2] / len]; };
  const decodeMaterialImage = (imageIndex) => {
    const mapFile = materials[imageIndex]._map;
    return decodeImage(mapFile, fs.readFileSync(path.join(dir, mapFile)));
  };

  if (log) log("OBJ: " + prims.length + " group(s), " + V.length + " vertices, " + materials.length + " material(s)");
  return { prims, materials, lights: [], decodeMaterialImage, applyMat4, applyMat3 };
}

module.exports = { loadObj };
