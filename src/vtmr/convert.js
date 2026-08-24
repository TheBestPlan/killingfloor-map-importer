// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Vampire: The Masquerade - Redemption -> Killing Floor .rom. A level is one `levels/*.nil` inside the
// game's `Levels.nob` (a ZIP). This reads its sector meshes (src/vtmr/nil.js) and hands the world
// triangles to the glTF route's builder - the same KF skeleton, auto-colour, spawn-drop and verify
// path the model and Source routes use. Input is a `.nil` file, or the `.nob` (converts every level
// unless one is named). Nod is Y-up, so it feeds axes [0,2,1]; a level is thousands of units across, so
// the default scale auto-fits it to a walkable KF extent. Textures (in the .nsa material files) and the
// exact surface topology (the strip is reconstructed, see nil.js) are approximate; see docs/games/vtmr.md.
"use strict";

const fs = require("fs");
const path = require("path");
const { readS2z } = require("../savage/s2z");
const { readNil } = require("./nil");
const { decodeTga } = require("./tga");
const gltf = require("../gltf/convert");

const TARGET_EXTENT = 40000;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const applyMat4 = (m, p) => [p[0], p[1], p[2]];
const applyMat3 = (m, n) => n;

// Resolve the input to { name, buf, dir } of one .nil: a loose .nil, or a level inside a .nob archive.
function pickNil(file, wanted) {
  if (/\.nil$/i.test(file)) return { name: path.basename(file), buf: fs.readFileSync(file), dir: path.dirname(file) };
  const files = readS2z(file);                       // a .nob is a ZIP
  const nils = [...files.keys()].filter((k) => /\.nil$/i.test(k));
  if (!nils.length) throw new Error("no .nil levels in " + path.basename(file));
  let key = nils[0];
  if (wanted) { const hit = nils.find((k) => k.toLowerCase().includes(wanted.toLowerCase())); if (hit) key = hit; }
  else { key = nils.reduce((a, b) => files.get(b).length > files.get(a).length ? b : a); }   // biggest level
  return { name: path.basename(key), buf: files.get(key), dir: path.dirname(file) };
}

// Open the game's level-material archive (LMaterials.nob) sitting next to Levels.nob, and hand back a
// decoder that turns a .nil material name into a { width, height, rgb, alpha? } image (cached). Returns
// null if the archive can't be found - textures then fall back to auto-colour.
function openMaterials(dir, matArg) {
  const cand = [matArg, path.join(dir, "LMaterials.nob"), path.join(dir, "..", "LMaterials.nob")].filter(Boolean);
  let nob = null;
  for (const c of cand) { if (fs.existsSync(c)) { try { nob = readS2z(c); break; } catch (e) { } } }
  if (!nob) return null;
  const cache = new Map();
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    let img = null;
    const p = "materials/" + name.replace(/\\/g, "/").toLowerCase().replace(/\.[a-z0-9]+$/, "") + ".tga";
    const e = nob.get(p);
    if (e) { try { img = decodeTga(e); } catch (x) { img = null; } }
    cache.set(name, img); return img;
  };
}

function loadVtmrScene(file, o, log) {
  const { name, buf, dir } = pickNil(file, o.level);
  const nil = readNil(buf);
  if (!nil.triangles) throw new Error("no sector geometry in " + name);
  const texOf = openMaterials(dir, o.materials);

  // Bounds from triangle-referenced wedges only - a mis-parsed sector can carry an unreferenced position
  // thousands of units away that would otherwise blow up the auto-fit scale.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const m of nil.meshes) { const used = new Set(); for (const s of m.surfaces) for (const t of s.tris) { used.add(t[0]); used.add(t[1]); used.add(t[2]); } for (const i of used) { const p = m.pos[i]; for (let k = 0; k < 3; k++) if (Number.isFinite(p[k])) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; } } }
  const span = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const scale = o.scale || (TARGET_EXTENT / Math.max(span[0], span[2], 1));   // fit the horizontal (X/Z) span
  const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);

  // Material registry: index 0 is the flat/auto-colour fallback; each named surface material becomes one
  // KF material with its LMaterials.nob texture decoded once.
  const materials = [{ name: "untextured", imageIndex: null, alphaMode: "OPAQUE", factor: [0.5, 0.5, 0.5, 1] }];
  const texList = [null];
  const matIndex = new Map();
  const resolveMat = (nilMatId) => {
    if (nilMatId < 0 || !texOf) return 0;
    if (matIndex.has(nilMatId)) return matIndex.get(nilMatId);
    const nm = nil.materials[nilMatId] || ("m" + nilMatId);
    const img = texOf(nm);
    const mi = materials.length;
    texList.push(img || null);
    materials.push({ name: nm.replace(/^.*\\/, ""), imageIndex: img ? mi : null, alphaMode: img && img.alpha ? "MASK" : "OPAQUE", factor: [0.5, 0.5, 0.5, 1] });
    matIndex.set(nilMatId, mi); return mi;
  };

  // Classify each material by the surface type its name encodes (Redemption names them SBIwall / SBIfloor /
  // SBIceiling / carpet / sidewalk / snow / curtain / arch ...), so a surface whose exact material the table
  // didn't give can still be textured: match the surface's own orientation to a same-type material from its
  // sector's palette. Not the authoritative per-face assignment, but the right kind of texture in the right
  // place (a floor texture on floors, a wall texture on walls).
  const bucketOf = (nm) => /ceiling/i.test(nm) ? "ceiling" : /floor|carpet|sidewalk|snow|ground|tile|stage/i.test(nm) ? "ground" : "wall";
  const levelByBucket = { ground: [], ceiling: [], wall: [] };
  nil.materials.forEach((nm, i) => { if (texOf && texOf(nm)) levelByBucket[bucketOf(nm)].push(i); });
  const anyTex = nil.materials.map((_, i) => i).filter((i) => texOf && texOf(nil.materials[i]));
  const pickByBucket = (bucket, matSet) => {
    const inSet = (matSet || []).filter((id) => texOf && texOf(nil.materials[id]) && bucketOf(nil.materials[id]) === bucket);
    if (inSet.length) return inSet[0];
    // cascade so nothing is left untextured: the bucket, then the sector's own palette, then a wall, then any.
    if (levelByBucket[bucket].length) return levelByBucket[bucket][0];
    const setTex = (matSet || []).filter((id) => texOf && texOf(nil.materials[id]));
    if (setTex.length) return setTex[0];
    if (levelByBucket.wall.length) return levelByBucket.wall[0];
    return anyTex.length ? anyTex[0] : -1;
  };
  // Orientation of a triangle in Nod space (Y is up): +Y face -> ground, -Y -> ceiling, sideways -> wall.
  const orientBucket = (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1, up = ny / l;
    return up > 0.5 ? "ground" : up < -0.5 ? "ceiling" : "wall";
  };

  const prims = [];
  let texTris = 0;
  const emit = (m, tris, matId) => {
    const mi = resolveMat(matId);
    const remap = new Map(), posArr = [], uvArr = [], idx = new Uint32Array(tris.length * 3);
    const map = (w) => { let r = remap.get(w); if (r === undefined) { r = posArr.length / 3; remap.set(w, r); posArr.push((m.pos[w][0] - c[0]) * scale, (m.pos[w][1] - c[1]) * scale, (m.pos[w][2] - c[2]) * scale); uvArr.push(m.uv[w][0], m.uv[w][1]); } return r; };
    for (let i = 0; i < tris.length; i++) { idx[i * 3] = map(tris[i][0]); idx[i * 3 + 1] = map(tris[i][1]); idx[i * 3 + 2] = map(tris[i][2]); }
    if (materials[mi] && materials[mi].imageIndex != null) texTris += tris.length;
    prims.push({ matrix: IDENTITY, pos: { data: Float32Array.from(posArr), count: posArr.length / 3 }, nrm: null, uv: { data: Float32Array.from(uvArr) }, indices: idx, material: mi });
  };
  for (const m of nil.meshes) {
    for (const surf of m.surfaces) {
      if (surf.mat >= 0) { emit(m, surf.tris, surf.mat); continue; }   // exact material from the table
      // no table material: split the surface by triangle orientation and texture each part by type.
      const byOri = { ground: [], ceiling: [], wall: [] };
      for (const t of surf.tris) byOri[orientBucket(m.pos[t[0]], m.pos[t[1]], m.pos[t[2]])].push(t);
      for (const bucket of ["ground", "ceiling", "wall"]) {
        if (!byOri[bucket].length) continue;
        emit(m, byOri[bucket], pickByBucket(bucket, m.matSet));
      }
    }
  }
  const withImg = texList.filter(Boolean).length;
  log("vtmr: " + name + " - " + nil.meshes.length + " sector(s), " + nil.triangles + " triangles, " + withImg +
    " texture(s)" + (texOf ? " (" + Math.round(100 * texTris / (nil.triangles || 1)) + "% of tris textured)" : ", no LMaterials.nob - auto-colour") +
    ", span " + span.map((v) => Math.round(v)).join("x") + " units, scale " + scale.toFixed(3) + (o.scale ? "" : " (auto-fit)"));

  return { prims, materials, lights: [], applyMat4, applyMat3, decodeMaterialImage: (i) => texList[i], baseName: name.replace(/\.nil$/i, "") };
}

function convert(opts) {
  const o = Object.assign({}, opts);
  const log = o.log || (() => { });
  const scene = loadVtmrScene(o.file, o, log);
  return gltf.convert(Object.assign({}, o, {
    scene, file: null, baseName: "VtMR-" + scene.baseName, mapName: o.mapName,
    axes: [0, 2, 1], flip: [0, 0, 0], scale: 1,          // Nod is Y-up; positions already centred + scaled
    autoColor: o.autoColor !== false,
    twoSided: o.twoSided !== false, groundUp: false,   // Redemption surfaces are single-sided - two-side so walls/floors aren't see-through
    ambient: o.ambient !== undefined ? o.ambient : 44, glow: o.glow !== undefined ? o.glow : 24,
    texGain: o.texGain !== undefined ? o.texGain : 0.5,   // unlit fullbright blows the textures out otherwise
    cullDistance: o.cullDistance !== undefined ? o.cullDistance : +(process.env.KF_CULL_DIST || 12000),
    title: scene.baseName + " (Vampire: The Masquerade - Redemption)",
  }));
}

module.exports = { convert, loadVtmrScene };
