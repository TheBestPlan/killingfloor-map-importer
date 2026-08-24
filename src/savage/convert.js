// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Savage: The Battle for Newerth (.s2z) map -> Killing Floor .rom. A Savage world is a heightmap
// terrain plus placed objects; this carries the terrain - a 128x128 float heightfield in the archive's
// .hm - as a static-mesh landscape, and hands it to the glTF route's builder (auto-coloured, spawn
// dropped on the surface, verified). Objects (.objpos referencing S2 .model files) are not carried
// yet, so the map is its landscape.
"use strict";

const fs = require("fs");
const path = require("path");
const { readS2z } = require("./s2z");
const { readModel } = require("./model");
const { readS2g } = require("./s2g");
const gltf = require("../gltf/convert");

// savage0.s2z (holds every prop .model) sits a level or two up from the world/<map>.s2z.
function findModelArchive(mapFile) {
  let dir = path.dirname(mapFile);
  for (let i = 0; i < 3; i++) { const p = path.join(dir, "savage0.s2z"); if (fs.existsSync(p)) return p; dir = path.dirname(dir); }
  return null;
}

const CELL = 180;          // KF units per heightmap cell (128 cells -> ~23000 uu across)
const HEIGHT = 6000;       // KF units for a full 0..1 height
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const applyMat4 = (m, p) => [p[0], p[1], p[2]];
const applyMat3 = (m, n) => n;

// The .hm: u32 width, u32 height, then width*height float32 heights in 0..1.
function readHeightmap(hm) {
  const width = hm.readUInt32LE(0), height = hm.readUInt32LE(4);
  if (width * height * 4 + 8 !== hm.length) throw new Error("unexpected .hm size (" + hm.length + " for " + width + "x" + height + ")");
  const h = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) h[i] = hm.readFloatLE(8 + i * 4);
  return { width, height, h };
}

function loadSavageScene(file, o, log) {
  const files = readS2z(file);
  let hmKey = null;
  for (const k of files.keys()) if (/\.hm$/.test(k)) { hmKey = k; break; }
  if (!hmKey) throw new Error("no .hm heightmap in " + path.basename(file));
  const { width, height, h } = readHeightmap(files.get(hmKey));

  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < h.length; i++) { if (h[i] < lo) lo = h[i]; if (h[i] > hi) hi = h[i]; }
  const cell = o.cell || CELL, hScale = o.heightScale || HEIGHT;

  const pos = new Float32Array(width * height * 3);
  const uv = new Float32Array(width * height * 2);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    pos[i * 3] = x * cell; pos[i * 3 + 1] = y * cell; pos[i * 3 + 2] = h[i] * hScale;
    uv[i * 2] = x / (width - 1); uv[i * 2 + 1] = y / (height - 1);
  }
  const indices = new Uint32Array((width - 1) * (height - 1) * 6);
  let n = 0;
  for (let y = 0; y < height - 1; y++) for (let x = 0; x < width - 1; x++) {
    const a = y * width + x, b = a + 1, c = a + width, d = c + 1;
    indices[n++] = a; indices[n++] = c; indices[n++] = b;
    indices[n++] = b; indices[n++] = c; indices[n++] = d;
  }
  log("savage: " + width + "x" + height + " heightfield (" + (indices.length / 3) + " triangles), height range " +
    lo.toFixed(2) + ".." + hi.toFixed(2) + " -> 0.." + Math.round((hi - lo) * hScale) + " uu");

  const prim = { matrix: IDENTITY, pos: { data: pos, count: width * height }, nrm: null, uv: { data: uv }, indices, material: 0 };

  // The .cm is the baked terrain colour map: u32 w, u32 h, then w*h*3 RGB. Applied straight over the
  // grid (its UVs are the grid position), it gives the landscape its real ground colours instead of a
  // flat auto-colour. Its row order is top-to-bottom vs the grid's bottom-to-top, so flip V.
  let cmImg = null;
  for (const k of files.keys()) if (/\.cm$/.test(k)) {
    const cm = files.get(k), cw = cm.readUInt32LE(0), ch = cm.readUInt32LE(4);
    if (8 + cw * ch * 3 <= cm.length) {
      const rgb = Buffer.alloc(cw * ch * 3);
      for (let yy = 0; yy < ch; yy++) cm.copy(rgb, yy * cw * 3, 8 + (ch - 1 - yy) * cw * 3, 8 + (ch - yy) * cw * 3);
      cmImg = { width: cw, height: ch, rgb };
    }
    break;
  }
  const materials = [{ name: "terrain", alphaMode: "OPAQUE", imageIndex: cmImg ? 0 : null }];
  if (cmImg) log("savage: terrain colour map " + cmImg.width + "x" + cmImg.height);

  // --- objects: .objpos places S2 .model props (ruins, huts, rocks, trees) around the terrain -----
  // `createObject <name> <x> <y> <z> <heading-deg> <scale> ...`. The prop models live in savage0.s2z;
  // resolve by basename, transform each mesh (scale, heading about the up axis) and drop it on the terrain
  // surface (sampled from the heightfield) so it sits on the ground instead of at its authored world Z.
  const prims = [prim];
  const objMat = materials.length;
  materials.push({ name: "object", alphaMode: "OPAQUE", imageIndex: null, factor: [0.62, 0.58, 0.5, 1] });
  const objposKey = [...files.keys()].find((k) => /\.objpos$/i.test(k));
  const arcPath = findModelArchive(file);
  if (objposKey && arcPath) {
    const arc = readS2z(arcPath);
    const modelIndex = new Map();
    for (const k of arc.keys()) if (/\.model$/i.test(k)) { const bn = path.basename(k).replace(/\.model$/i, "").toLowerCase(); if (!modelIndex.has(bn)) modelIndex.set(bn, k); }
    const modelCache = new Map();
    const getModel = (bn) => { if (modelCache.has(bn)) return modelCache.get(bn); const kp = modelIndex.get(bn); let m = null; if (kp) { try { m = { meshes: readModel(arc.get(kp)).meshes, dir: kp.replace(/[^/]*$/, "") }; } catch (e) { } } modelCache.set(bn, m); return m; };
    // Object textures: the mesh names a .tga, but the pixels live in a .s2g next to the model (S2's own
    // format, reverse-engineered in s2g.js). Resolve+decode once per texture; unresolved -> auto-colour.
    const texList = [cmImg, null];   // material 0 = terrain, 1 = objMat (flat)
    const texCache = new Map();
    const resolveTex = (dir, texName) => {
      if (!texName) return objMat;
      const base = texName.replace(/^.*[\\/]/, "").replace(/\.\w+$/, ""), key = dir + base;
      if (texCache.has(key)) return texCache.get(key);
      let img = null;
      const s2g = arc.get(dir + base + ".s2g"); if (s2g) { try { img = readS2g(s2g); } catch (e) { } }
      let mi = objMat;
      if (img) { mi = materials.length; materials.push({ name: base, alphaMode: img.alpha ? "MASK" : "OPAQUE", imageIndex: mi, factor: [1, 1, 1, 1] }); texList.push(img); }
      texCache.set(key, mi); return mi;
    };
    const sampleH = (kx, ky) => {
      const gx = Math.max(0, Math.min(width - 1.001, kx / cell)), gy = Math.max(0, Math.min(height - 1.001, ky / cell));
      const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
      const h0 = h[y0 * width + x0] * (1 - fx) + h[y0 * width + x0 + 1] * fx;
      const h1 = h[(y0 + 1) * width + x0] * (1 - fx) + h[(y0 + 1) * width + x0 + 1] * fx;
      return (h0 * (1 - fy) + h1 * fy) * hScale;
    };
    const POS = +(o.objPosScale || process.env.KF_SAVAGE_POS || 2.0);   // objpos world units -> KF (spreads objects across the terrain)
    const MDL = +(o.objModelScale || process.env.KF_SAVAGE_MDL || 0.4);  // model units * objpos scale -> KF (0.4 keeps huts/ruins/trees at sane size vs the pawn)
    let placed = 0, missing = 0, objTris = 0; const missNames = new Set();
    for (const line of files.get(objposKey).toString("latin1").split(/\r?\n/)) {
      const mt = line.match(/^createObject\s+(\S+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/i);
      if (!mt) continue;
      const model = getModel(mt[1].toLowerCase());
      if (!model) { missing++; missNames.add(mt[1]); continue; }
      const kx = +mt[2] * POS, ky = +mt[3] * POS, kz = sampleH(kx, ky);
      const rad = +mt[5] * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad), s = +mt[6] * MDL;
      for (const me of model.meshes) {
        const n = me.verts.length / 3, wp = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          const lx = me.verts[i * 3] * s, ly = me.verts[i * 3 + 1] * s, lz = me.verts[i * 3 + 2] * s;
          wp[i * 3] = kx + lx * cos - ly * sin; wp[i * 3 + 1] = ky + lx * sin + ly * cos; wp[i * 3 + 2] = kz + lz;
        }
        prims.push({ matrix: IDENTITY, pos: { data: wp, count: n }, nrm: null, uv: me.uvs ? { data: me.uvs } : null, indices: me.indices, material: resolveTex(model.dir, me.texture) });
        objTris += me.indices.length / 3;
      }
      placed++;
    }
    log("savage: placed " + placed + " objects (" + Math.round(objTris) + " triangles), " + (materials.length - 2) + " object textures" + (missing ? ", " + missing + " unresolved (" + [...missNames].slice(0, 6).join(", ") + ")" : ""));
    return { prims, materials, lights: [], applyMat4, applyMat3, decodeMaterialImage: (i) => texList[i] };
  }

  return { prims, materials, lights: [], applyMat4, applyMat3, decodeMaterialImage: () => cmImg };
}

function convert(opts) {
  const o = Object.assign({}, opts);
  const log = o.log || (() => { });
  const scene = loadSavageScene(o.file, o, log);
  const baseName = path.basename(o.file).replace(/\.s2z$/i, "");
  return gltf.convert(Object.assign({}, o, {
    scene, file: null, baseName, mapName: o.mapName,
    axes: [0, 1, 2], flip: [0, 0, 0], scale: o.scale || 1,
    autoColor: o.autoColor !== false,
    twoSided: o.twoSided !== false, groundUp: false,   // terrain is a single surface; two-side it so it's visible/solid regardless of winding
    ambient: o.ambient !== undefined ? o.ambient : 46, glow: o.glow !== undefined ? o.glow : 26,
    title: baseName + " (Savage: The Battle for Newerth)",
  }));
}

module.exports = { convert, loadSavageScene };
