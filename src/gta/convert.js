// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// GTA III / Vice City map -> Killing Floor .rom. The map is a set of instances (.ipl) of RenderWare
// models (.dff, in the game's IMG archive) named by item definitions (.ide). This reads every
// instance, decodes each referenced model once, transforms its geometry by the instance's
// position / scale / rotation, and hands the world triangles to the glTF route's builder - the same
// KF skeleton, auto-colour, spawn-drop and verify path the model and Source routes use. GTA is Z-up
// and metre-scaled, so it feeds axes [0,1,2] with a Y flip.
//
// A whole GTA city is millions of triangles across kilometres - far too big for one KF map. Three ways
// to size it down:
//   - default: one walkable district (the densest 100 m grid cell), half a set radius.
//   - --crop cx,cy,half / --whole: a named area, or the entire city.
//   - --tile <m>: split the WHOLE map into <m>-metre squares and write one .rom per populated square
//     (KF-GTA3-01, KF-GTA3-02, ...). Each instance is placed WHOLE into the square its origin falls in
//     (models are never cut mid-mesh), and a small overlap margin pulls in the neighbouring context so a
//     lamp keeps the wall behind it and a building keeps its base - no floating meshes at the seam.
"use strict";

const fs = require("fs");
const path = require("path");
const { Img } = require("./img");
const { readDff } = require("./dff");
const { readTxd, readTxdNames } = require("./txd");
const { readIde, readIpl, findDataFiles } = require("./placement");
const gltf = require("../gltf/convert");

// GTA metres -> KF units, by character parity (same principle as Lineage2's 100/46 and CS): the GTA player
// ped mesh is 1.665 m tall (player.dff bbox Z; other peds 1.63-1.71) and KFHumanPawn is 100 uu, so
// 100 / 1.665 = 60.06 stands the KF pawn in the world at a real ped's height. The earlier 40 left the pawn
// oversized against the world. --scale overrides.
const SCALE = 60.06;
const TILE_METERS = 400;      // default --tile square size: a ~400 m block matches the old default district (~160k tris), which stays whole without decimation
const TILE_OVERLAP_FRAC = 0.12; // how far past the square edge to pull neighbouring instances, so seam objects keep their context
const MIN_TILE_INSTANCES = 12;  // a square with fewer instance origins than this is open water / empty - skip it
const TILE_MAX_TEXTURE = 256;   // tiles carry the whole area's textures; 256 keeps each .rom light and quick to load (like the de_dust2 fix)
const TILE_HEAVY_TRIS = 800000; // a doubled tile past this loads slowly in KF - warn and suggest a smaller square
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const applyMat4 = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
const applyMat3 = (m, n) => [m[0] * n[0] + m[4] * n[1] + m[8] * n[2], m[1] * n[0] + m[5] * n[1] + m[9] * n[2], m[2] * n[0] + m[6] * n[1] + m[10] * n[2]];

// Rotate a vector by a quaternion (x,y,z,w). GTA IPL quaternions place the instance.
function quatRotate(q, v) {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

function findImg(root) {
  for (const rel of ["models/gta3.img", "models/gta_int.img"]) {
    const p = path.join(root, rel);
    if (fs.existsSync(p) && fs.existsSync(p.replace(/\.img$/i, ".dir"))) return p;
  }
  throw new Error("no models/gta3.img (+ .dir) under " + root);
}

// Parse the game data once and hand back the instance list plus a scene builder. buildScene(subset) turns
// any subset of instances into a KF scene with its OWN material registry (so a tile's .rom carries only the
// textures it uses); the decoded-model and txd caches are shared across every call.
function loadGtaCommon(root, log) {
  const img = new Img(findImg(root));
  const files = findDataFiles(root);
  const idToModel = readIde(files.ide);
  const allInstances = readIpl(files.ipl);
  // Drop big-building / LOD stand-ins (draw distance > 300 = re3's LOD_DISTANCE). GTA draws these only at
  // range, with the detailed model in their place up close; in a static close-range KF export they instead
  // OVERLAP the real geometry as crude low-detail stand-ins - glowing-window LOD blocks over the real
  // building, flat 2D tree cards over the real trees, the distant-island skyline block. The name-prefix
  // "lod" filter in readIpl catches most; this catches the rest (islandlod*, *_vlo, unprefixed big builds).
  const LOD_DRAWDIST = 300;
  const instances = allInstances.filter((i) => { const d = idToModel.get(i.id); return !d || !(d.drawDist > LOD_DRAWDIST); });
  log("gta: " + img.entries.size + " archived files, " + idToModel.size + " item definitions, " + instances.length + " instances (" + (allInstances.length - instances.length) + " LOD/big-building dropped)");

  const dffCache = new Map();       // model name -> decoded geometries (or null on failure)
  const getModel = (name) => {
    if (dffCache.has(name)) return dffCache.get(name);
    let geos = null;
    const data = img.read(name);
    if (data) { try { geos = readDff(data).geometries; } catch (e) { geos = null; } }
    dffCache.set(name, geos);
    return geos;
  };

  // Longest bbox edge of an instance's model, in GTA metres. The tile overlap uses it to tell small street
  // furniture (lamps, signs, benches - keep their seam context) from large structures (terrain, buildings,
  // the elevated railway - assign strictly by origin so a neighbour tile's piece is not dragged in).
  const sizeCache = new Map();
  const sizeOf = (inst) => {
    const def = idToModel.get(inst.id); const name = def ? def.model : inst.model;
    if (sizeCache.has(name)) return sizeCache.get(name);
    const geos = getModel(name); let d = 0;
    if (geos) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const g of geos) { if (!g.verts) continue; for (let i = 0; i < g.verts.length; i += 3) for (let c = 0; c < 3; c++) { const v = g.verts[i + c]; if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; } }
      d = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    }
    sizeCache.set(name, d); return d;
  };

  // Textures: each model names a .txd in its .ide; the .dff materials name a raster inside it.
  const txdCache = new Map();
  const getTxd = (name) => { if (txdCache.has(name)) return txdCache.get(name); let m = null; const data = name && img.read(name); if (data) { try { m = readTxd(data); } catch (e) { } } txdCache.set(name, m); return m; };
  // Parent-chain fallback: a model's raster often lives in a shared txd (vegetation, generic), not the
  // model's own. Index every referenced txd's names once (headers only, no decode) so a miss resolves.
  let globalIdx = null;
  const findTxdFor = (texName) => {
    if (!globalIdx) {
      globalIdx = new Map(); const seen = new Set();
      for (const def of idToModel.values()) {
        if (!def.txd || seen.has(def.txd)) continue; seen.add(def.txd);
        const data = img.read(def.txd); if (!data) continue;
        try { for (const nm of readTxdNames(data)) if (!globalIdx.has(nm)) globalIdx.set(nm, def.txd); } catch (e) { }
      }
    }
    return globalIdx.get(texName);
  };

  const buildScene = (subset) => {
    // One KF material per resolved raster (material 0 is the flat fallback for untextured / unresolved).
    const materials = [{ name: "untextured", imageIndex: null, alphaMode: "OPAQUE", factor: [0.55, 0.55, 0.55, 1] }];
    const texList = [null];            // texList[i] is the image for materials[i]
    const texKey = new Map();
    const resolveTexMat = (txdName, texName) => {
      if (!texName) return 0;
      const key = txdName + "|" + texName;
      if (texKey.has(key)) return texKey.get(key);
      let im = null; const txd = getTxd(txdName); if (txd) im = txd.get(texName);
      if (!im) { const alt = findTxdFor(texName); if (alt && alt !== txdName) { const t2 = getTxd(alt); if (t2) im = t2.get(texName); } }   // parent-chain fallback
      const mi = materials.length;
      texList.push(im || null);
      materials.push({ name: texName, imageIndex: im ? mi : null, alphaMode: im && im.alpha ? "MASK" : "OPAQUE", factor: [0.55, 0.55, 0.55, 1] });
      texKey.set(key, mi);
      return mi;
    };

    const prims = [];
    let placed = 0, missing = 0, tris = 0;
    for (const inst of subset) {
      const def = idToModel.get(inst.id) || { model: inst.model, txd: "" };
      const geos = getModel(def.model);
      if (!geos) { missing++; continue; }
      // The IPL stores the CONJUGATE of the instance's world orientation (verified against GTA tooling -
      // opensa, quarry), so the rotation must be conjugated (negate x,y,z) before it is applied. Skipping
      // this yawed every rotated object the wrong way - traffic-light arms and road pieces faced backwards
      // and would not line up - while identity / 180 degree instances (conjugate-invariant) looked fine and
      // hid the bug.
      const qr = inst.quat, q = [-qr[0], -qr[1], -qr[2], qr[3]], s = inst.scale, pos = inst.pos;
      for (const g of geos) {
        const n = g.verts.length / 3;
        const world = new Float32Array(g.verts.length);
        for (let i = 0; i < n; i++) {
          const lv = [g.verts[i * 3] * s[0], g.verts[i * 3 + 1] * s[1], g.verts[i * 3 + 2] * s[2]];
          const r = quatRotate(q, lv);
          world[i * 3] = r[0] + pos[0]; world[i * 3 + 1] = r[1] + pos[1]; world[i * 3 + 2] = r[2] + pos[2];
        }
        const uv = g.uvs ? { data: g.uvs } : null;
        // one prim per material used by this geometry, sharing the world vertex buffer
        const byMat = new Map();
        for (const t of g.tris) {
          const mi = resolveTexMat(def.txd, g.materials && g.materials[t[3]]);
          let arr = byMat.get(mi); if (!arr) { arr = []; byMat.set(mi, arr); }
          arr.push(t[0], t[1], t[2]);
        }
        for (const [mi, idxArr] of byMat) {
          prims.push({ matrix: IDENTITY, pos: { data: world, count: n }, nrm: null, uv, indices: Uint32Array.from(idxArr), material: mi });
          tris += idxArr.length / 3;
        }
      }
      placed++;
    }
    return {
      prims, materials, lights: [], applyMat4, applyMat3, decodeMaterialImage: (i) => texList[i],
      stats: { placed, missing, triangles: tris, textures: texList.filter(Boolean).length },
    };
  };

  return { instances, buildScene, sizeOf };
}

// The densest 100 m grid cell (a built-up area, never open water), for the default single-district crop.
function densestDistrict(instances, o, log) {
  const cells = new Map();
  for (const inst of instances) { const k = Math.round(inst.pos[0] / 100) + "," + Math.round(inst.pos[1] / 100); cells.set(k, (cells.get(k) || 0) + 1); }
  let best = null, bestN = -1;
  for (const [k, n] of cells) if (n > bestN) { bestN = n; best = k; }
  const [cx, cy] = best.split(",").map(Number).map((v) => v * 100);
  // 220 m keeps the doubled tri count (~260k) under maxTris so the district is NOT decimated - decimation
  // was cutting 40% of the walls and punching the holes seen in-game. A complete 440 m district beats a
  // holed 700 m one; --crop cx,cy,half overrides for a bigger area, --tile splits the whole city.
  const crop = { cx, cy, half: o.cropHalf || 220 };
  log("gta: no --crop/--tile given - defaulting to the densest district at (" + cx + ", " + cy + ") half " + crop.half + " m; --tile <m> splits the whole city into squares");
  return crop;
}

// Assign every instance to its <size>-metre square by ORIGIN (whole model, no mid-mesh cut). Returns the
// populated squares (>= minInst origins) in row-major order, each with the instance subset that renders it
// - which includes an overlap margin so a seam object keeps the neighbouring geometry it leans on.
function tileInstances(instances, size, overlap, minInst) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const i of instances) { const x = i.pos[0], y = i.pos[1]; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  const col = (x) => Math.floor((x - minX) / size), row = (y) => Math.floor((y - minY) / size);
  const count = new Map();
  for (const i of instances) { const k = col(i.pos[0]) + "," + row(i.pos[1]); count.set(k, (count.get(k) || 0) + 1); }
  const cells = [...count.entries()].filter(([, n]) => n >= minInst).map(([k]) => k.split(",").map(Number))
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);      // row-major: row (y) then col (x)
  const half = size / 2 + overlap;
  return {
    span: [Math.round(maxX - minX), Math.round(maxY - minY)],
    tiles: cells.map(([c, r]) => {
      const cx = minX + (c + 0.5) * size, cy = minY + (r + 0.5) * size;
      const subset = instances.filter((i) => Math.abs(i.pos[0] - cx) <= half && Math.abs(i.pos[1] - cy) <= half);
      return { col: c, row: r, cx: Math.round(cx), cy: Math.round(cy), subset };
    }),
  };
}

function convert(opts) {
  const o = Object.assign({}, opts);
  const log = o.log || (() => { });
  const root = o.clientDir || o.file;
  const baseName = o.game === "vc" ? "ViceCity" : "GTA3";
  const S = o.scale || SCALE;
  const common = loadGtaCommon(root, log);

  const gltfConvert = (scene, mapName, extra) => gltf.convert(Object.assign({}, o, {
    scene, file: null, baseName, mapName,
    axes: [0, 1, 2], flip: [0, 1, 0], scale: S,
    autoColor: o.autoColor !== false,
    twoSided: o.twoSided !== false, groundUp: false,   // GTA .dff faces are single-sided - two-side them so buildings/roads aren't see-through (holes in walls)
    maxTris: o.maxTris !== undefined ? o.maxTris : +(process.env.KF_GTA_MAX_TRIS || 400000),   // doubling makes a district ~660k tris (170 MB); cap it
    texGain: o.texGain !== undefined ? o.texGain : 0.6,
    ambient: o.ambient !== undefined ? o.ambient : 60, glow: o.glow !== undefined ? o.glow : 40,
    cullDistance: o.cullDistance !== undefined ? o.cullDistance : +(process.env.KF_CULL_DIST || 12000),
    crop: null,   // crop is applied in world units above, before scaling, not in the glTF builder
    title: baseName + (o.game === "vc" ? " (Grand Theft Auto: Vice City)" : " (Grand Theft Auto III)"),
  }, extra || {}));

  // --tile <m>: split the whole city into squares, one .rom per populated square. Returns an ARRAY.
  const tileSize = o.tile === true ? TILE_METERS : (typeof o.tile === "number" && o.tile > 0 ? o.tile : 0);
  if (tileSize) {
    if (o.outFile) { o.outDir = o.outDir || path.dirname(o.outFile); o.outFile = null; }   // one file name can't hold many tiles - write into its folder
    const overlap = o.tileOverlap !== undefined ? o.tileOverlap : Math.round(tileSize * TILE_OVERLAP_FRAC);
    const minInst = o.minInstances !== undefined ? o.minInstances : MIN_TILE_INSTANCES;
    const { span, tiles } = tileInstances(common.instances, tileSize, overlap, minInst);
    log("gta: tiling " + span[0] + "x" + span[1] + " m into " + tileSize + " m squares - " + tiles.length + " populated tile(s) (>= " + minInst + " instances each), " + overlap + " m overlap");
    // A dense tile is decimated to the triangle budget the same way the district is - coverage-preserving
    // vertex clustering, so a capped tile keeps its walls instead of holing out (src/gltf/decimate). Its
    // textures are capped smaller than the district's so the many .rom files stay light and quick to load.
    // A tile still over the heavy mark after that is flagged so the user can shrink --tile.
    const tileMaxTex = o.maxTexture !== undefined ? o.maxTexture : TILE_MAX_TEXTURE;
    const results = [];
    let idx = 0;
    for (const t of tiles) {
      const scene = common.buildScene(t.subset);
      if (!scene.prims.length) continue;
      idx++;
      const nn = String(idx).padStart(2, "0");
      const mapName = o.mapName ? o.mapName + "-" + nn : "KF-" + baseName + "-" + nn;
      log("gta: tile " + nn + " grid(" + t.col + "," + t.row + ") centre(" + t.cx + "," + t.cy + ") - " +
        scene.stats.placed + " instances, " + Math.round(scene.stats.triangles) + " tris, " + scene.stats.textures + " textures" +
        (scene.stats.missing ? ", " + scene.stats.missing + " model(s) missing" : ""));
      const r = gltfConvert(scene, mapName, { maxTexture: tileMaxTex });
      if (r.stats && r.stats.triangles > TILE_HEAVY_TRIS) log("gta:   tile " + nn + " is heavy (" + r.stats.triangles + " tris) - a smaller --tile loads faster");
      results.push(r);
    }
    if (!results.length) throw new Error("no populated tiles (raise --tile size or lower --min-instances)");
    return results;
  }

  // Single-scene default: one district (densest cell), or --crop / --whole.
  let crop = o.crop ? (() => { const [cx, cy, half] = o.crop.split(",").map(Number); return { cx, cy, half }; })() : null;
  if (!crop && !o.whole) crop = densestDistrict(common.instances, o, log);
  const subset = crop ? common.instances.filter((i) => Math.abs(i.pos[0] - crop.cx) <= crop.half && Math.abs(i.pos[1] - crop.cy) <= crop.half) : common.instances;
  const scene = common.buildScene(subset);
  log("gta: placed " + scene.stats.placed + " instances (" + Math.round(scene.stats.triangles) + " triangles), " + scene.stats.textures + " textures" +
    (scene.stats.missing ? ", " + scene.stats.missing + " model(s) missing" : "") + (crop ? " within crop" : ""));
  if (!scene.prims.length) throw new Error("no geometry placed (wrong folder, or crop excluded everything)");
  return gltfConvert(scene, o.mapName);
}

module.exports = { convert, loadGtaCommon };
