// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Source 2 (CS2 / Dota 2 / HL:Alyx) map .vpk -> Killing Floor .rom.
//
// A Source 2 map bakes its world geometry into aggregate/overlay meshes embedded in the map .vpk as
// compiled .vmdl_c resources: a CTRL block (binary KV3) names each mesh's vertex/index buffers and
// their layout, and the MVTX/MIDX blocks hold those buffers meshopt-compressed. The buffers are
// already in world space, so reading every embedded mesh and un-compressing it rebuilds the level
// shell without walking the scene graph. Those triangles become the glTF route's scene shape and go
// through its builder - the same KF skeleton, auto-colour, spawn-drop and verify path the model and
// Source 1 routes use. Source 2 is Z-up and inch-scaled like GoldSrc, so it feeds axes [0,1,2] with a
// Y flip and the GoldSrc pawn-fit scale.
//
// Textures ARE carried: each baked per-material .vmdl_c names one .vmat in its RERL block, whose g_tColor
// vtex_c is read from the game's shared pak01_dir.vpk and decoded (DXT1/DXT5/BC7/raw - src/source2/vtex.js)
// with the mesh's TEXCOORD-0 UVs; a face whose texture can't be resolved falls back to auto-colour. External
// prop models placed by the worldnodes' scene objects are still not carried. See docs/games/source2.md.
"use strict";

const fs = require("fs");
const path = require("path");
const { Vpk } = require("./vpk");
const { readResource } = require("./resource");
const { parseKV3 } = require("./kv3");
const { decodeVtex } = require("./vtex");
const meshopt = require("./meshopt");
const gltf = require("../gltf/convert");

const SCALE = 1.9165;   // GoldSrc/Source inches -> Unreal units, same ruler the Source 1 route uses
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const applyMat4 = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
const applyMat3 = (m, n) => [m[0] * n[0] + m[4] * n[1] + m[8] * n[2], m[1] * n[0] + m[5] * n[1] + m[9] * n[2], m[2] * n[0] + m[6] * n[1] + m[10] * n[2]];

// DXGI-format ids seen in Source 2 vertex layouts. Positions are float32x3 (6); the primary diffuse UV
// is TEXCOORD semantic-index 0, stored as float2 (16), half2 (34), unorm16 (35) or snorm16 (37).
const FMT_R32G32B32_FLOAT = 6, FMT_R32G32_FLOAT = 16, FMT_R16G16_FLOAT = 34, FMT_R16G16_UNORM = 35, FMT_R16G16_SNORM = 37;
const UV_FORMATS = [FMT_R32G32_FLOAT, FMT_R16G16_FLOAT, FMT_R16G16_UNORM, FMT_R16G16_SNORM];

// IEEE-754 half (float16) -> Number. Node has no native half read; UVs are stored as half2.
function half(u16) {
  const e = (u16 >> 10) & 0x1f, f = u16 & 0x3ff, s = (u16 & 0x8000) ? -1 : 1;
  if (e === 0) return s * f * 5.9604644775390625e-8;             // subnormal: 2^-24 * f
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * Math.pow(2, e - 15);
}

// Read the primary diffuse UV (TEXCOORD 0) from whichever of a mesh's vertex buffers carries it. Source 2
// world meshes split position into buffer 0 and the UV/normal/colour attributes into buffer 1, so the UV
// is not always in the same buffer as the position.
function readUvs(res, vbs, count) {
  for (const vb of vbs) {
    const f = (vb.m_inputLayoutFields || []).find((x) => /^TEXCOORD$/i.test(x.m_pSemanticName) && x.m_nSemanticIndex === 0 && UV_FORMATS.includes(x.m_Format));
    if (!f) continue;
    const blk = res.blocks[vb.m_nBlockIndex];
    if (!blk || vb.m_nElementCount !== count) return null;
    const st = vb.m_nElementSizeInBytes, fo = f.m_nOffset, fmt = f.m_Format;
    const buf = vb.m_bMeshoptCompressed ? meshopt.decodeVertexBuffer(count, st, blk.data) : blk.data;
    const data = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const o = i * st + fo;
      if (fmt === FMT_R32G32_FLOAT) { data[i * 2] = buf.readFloatLE(o); data[i * 2 + 1] = buf.readFloatLE(o + 4); }
      else if (fmt === FMT_R16G16_UNORM) { data[i * 2] = buf.readUInt16LE(o) / 65535; data[i * 2 + 1] = buf.readUInt16LE(o + 2) / 65535; }
      else if (fmt === FMT_R16G16_SNORM) { data[i * 2] = buf.readInt16LE(o) / 32767; data[i * 2 + 1] = buf.readInt16LE(o + 2) / 32767; }
      else { data[i * 2] = half(buf.readUInt16LE(o)); data[i * 2 + 1] = half(buf.readUInt16LE(o + 2)); }
    }
    return { data };
  }
  return null;
}

// One embedded mesh's vertex/index buffers -> world-space triangles as a glTF-route primitive.
function primFromMesh(res, emesh, matIndex) {
  const vbs = emesh.m_vertexBuffers || [];
  const vb = vbs[0];
  const ib = emesh.m_indexBuffers && emesh.m_indexBuffers[0];
  if (!vb || !ib) return null;
  const posField = (vb.m_inputLayoutFields || []).find((f) => /POSITION/i.test(f.m_pSemanticName));
  if (!posField || posField.m_Format !== FMT_R32G32B32_FLOAT) return null;   // only plain float3 positions
  const vblk = res.blocks[vb.m_nBlockIndex], iblk = res.blocks[ib.m_nBlockIndex];
  if (!vblk || !iblk) return null;

  const stride = vb.m_nElementSizeInBytes, count = vb.m_nElementCount;
  const vbuf = vb.m_bMeshoptCompressed ? meshopt.decodeVertexBuffer(count, stride, vblk.data) : vblk.data;
  const ibuf = ib.m_bMeshoptCompressed ? meshopt.decodeIndexBuffer(ib.m_nElementCount, ib.m_nElementSizeInBytes, iblk.data) : iblk.data;

  const pos = new Float32Array(count * 3);
  const po = posField.m_nOffset;
  for (let i = 0; i < count; i++) {
    const o = i * stride + po;
    pos[i * 3] = vbuf.readFloatLE(o); pos[i * 3 + 1] = vbuf.readFloatLE(o + 4); pos[i * 3 + 2] = vbuf.readFloatLE(o + 8);
  }
  const uv = readUvs(res, vbs, count);
  const isz = ib.m_nElementSizeInBytes, icount = ib.m_nElementCount;
  const indices = new Uint32Array(icount);
  for (let i = 0; i < icount; i++) indices[i] = isz === 2 ? ibuf.readUInt16LE(i * 2) : ibuf.readUInt32LE(i * 4);

  return { matrix: IDENTITY, pos: { data: pos, count }, nrm: null, uv, indices, material: matIndex };
}

// The model's material: a Source 2 aggregate/prop resource lists its referenced resources in the RERL
// block; a baked per-material mesh names exactly one .vmat there. Entry = { u64 id, u32 nameOffset }.
function firstVmat(res) {
  const r = res.block("RERL");
  if (!r) return null;
  const d = r.data, off = d.readUInt32LE(0), cnt = d.readUInt32LE(4);
  let p = 8 + (off - 8);
  for (let i = 0; i < cnt; i++) {
    const no = d.readUInt32LE(p + 8), s = p + 8 + no;
    let e = s; while (d[e]) e++;
    const name = d.toString("latin1", s, e);
    if (/\.vmat$/i.test(name)) return name;
    p += 12;
  }
  return null;
}

// Open the game's shared content archive (pak01_dir.vpk), which holds the compiled materials and
// textures the map references but does not embed. A map lives at <game>/maps/<name>.vpk, so its shared
// pak sits one level up. Returns null if it can't be found - textures then fall back to auto-colour.
function openSharedPak(mapFile) {
  const cand = [
    path.join(path.dirname(mapFile), "..", "pak01_dir.vpk"),   // <game>/pak01_dir.vpk
    path.join(path.dirname(mapFile), "pak01_dir.vpk"),
  ];
  for (const c of cand) { if (fs.existsSync(c)) { try { return new Vpk(c); } catch (e) { } } }
  return null;
}

// Read every embedded baked mesh in the map .vpk into one scene the glTF route can build. Each baked
// per-material model names one .vmat in its RERL block; that material's g_tColor texture is decoded from
// the shared pak and carried as the model's KF material (untextured/undecodable ones auto-colour).
function loadSource2Scene(file, log, o) {
  o = o || {};
  const vpk = new Vpk(file);
  const shared = openSharedPak(file);

  // Material registry: index 0 is the flat fallback; each resolved .vmat becomes one material, its
  // g_tColor image decoded once and cached (many models reuse the same material).
  const materials = [{ name: "world", imageIndex: null, alphaMode: "OPAQUE", factor: [0.5, 0.5, 0.5, 1] }];
  const texList = [null];
  const matCache = new Map();          // .vmat path -> material index
  const resolveMaterial = (vmat) => {
    if (!vmat || !shared) return 0;
    if (matCache.has(vmat)) return matCache.get(vmat);
    let img = null;
    try {
      const me = shared.get(vmat.replace(/\.vmat$/i, ".vmat_c").toLowerCase());
      if (me) {
        const kv = parseKV3(readResource(shared.read(me)).block("DATA").data, 0);
        const col = (kv.m_textureParams || []).find((t) => /g_tColor/i.test(t.m_name));
        if (col) { const ve = shared.get((col.m_pValue + "_c").toLowerCase()); if (ve) img = decodeVtex(shared.read(ve)); }
      }
    } catch (e) { img = null; }        // unresolved / unhandled texture format -> flat, auto-coloured
    const mi = materials.length;
    texList.push(img || null);
    materials.push({ name: vmat.split("/").pop().replace(/\.vmat$/i, ""), imageIndex: img ? mi : null, alphaMode: img && img.alpha ? "MASK" : "OPAQUE", factor: [0.5, 0.5, 0.5, 1] });
    matCache.set(vmat, mi);
    return mi;
  };

  // Walk the world scene graph: world.vwrld_c -> m_worldNodes -> n.vwnod_c. The VISIBLE world geometry is
  // the m_aggregateSceneObjects' baked (world-space) meshes; m_sceneObjects here are invisible block-light
  // volumes (toolsblocklight material) that only bake lighting, so they are skipped. The full map is ~4.5M
  // triangles - far too heavy for KF - so meshes are picked by category: the GROUND (walkable floor) is
  // always kept, then WALLS and PROPS are added smallest-first up to a triangle budget (many distinct pieces
  // rather than a few map-spanning merges), and FOLIAGE is dropped. A vpk with no world graph (a loose model
  // pack) falls back to reading every embedded mesh.
  const aggPaths = [];
  const worldEntry = vpk.list("vwrld_c")[0];
  if (worldEntry) {
    try {
      const world = parseKV3(readResource(vpk.read(worldEntry)).block("DATA").data, 0);
      for (const node of (world.m_worldNodes || [])) {
        const prefix = String(node.m_worldNodePrefix || "").replace(/\\/g, "/");
        const wnEntry = prefix && vpk.get(prefix + ".vwnod_c");
        if (!wnEntry) continue;
        const wn = parseKV3(readResource(vpk.read(wnEntry)).block("DATA").data, 0);
        for (const a of (wn.m_aggregateSceneObjects || [])) if (a.m_renderableModel) aggPaths.push(a.m_renderableModel);
      }
    } catch (e) { }
  }

  // Category from the material name: 0 GROUND (kept whole), 1 WALLS, 2 PROPS, 3 FOLIAGE (dropped).
  const catOf = (nm) => {
    const n = String(nm || "").toLowerCase();
    if (/agave|palm|plant|frond|bark|sumac|grass|foliage|bush|leaf|vine|weed|olive|tree/.test(n)) return 3;
    if (/floor|ground|sand|sidewalk|concrete|road|tile|dirt|gravel|plaster|carpet/.test(n)) return 0;
    if (/wall|brick|arch|column|building|edge|trim|stone|rock|kasbah|tower|roof|window_frame|plank/.test(n)) return 1;
    return 2;
  };
  const maxTris = o.maxTris !== undefined ? o.maxTris : +(process.env.KF_S2_MAX_TRIS || 350000);   // 500k rendered ~372k doubled tris and lagged in-game; 350k (~260k doubled) stays coverage-complete but lighter
  const keepFoliage = o.foliage === true;

  const prims = [];
  let tris = 0, skipped = 0, texTris = 0, dropped = 0;
  const seen = new Set();

  // Scan pass (cheap: CTRL + RERL only) to categorise + size every candidate model, then pick.
  const cand = [];
  const scan = (modelPath) => {
    const key = String(modelPath).replace(/\\/g, "/").toLowerCase();
    const entry = vpk.get(key.endsWith("_c") ? key : key + "_c");
    if (!entry || seen.has(entry.path)) return; seen.add(entry.path);
    let res; try { res = readResource(vpk.read(entry)); } catch (e) { return; }
    if (!res.block("CTRL") || !res.block("MVTX")) return;
    let ctrl; try { ctrl = parseKV3(res.block("CTRL").data, 0); } catch (e) { skipped++; return; }
    if (!Array.isArray(ctrl.embedded_meshes)) return;
    const vmat = firstVmat(res), cat = catOf(vmat);
    let t = 0; for (const em of ctrl.embedded_meshes) { const ib = em.m_indexBuffers && em.m_indexBuffers[0]; if (ib) t += ib.m_nElementCount / 3; }
    cand.push({ res, ctrl, vmat, cat, t });
  };
  if (aggPaths.length) for (const p of aggPaths) scan(p);
  else for (const entry of vpk.list("vmdl_c")) scan(entry.path);

  // Keep the whole world shell - GROUND, WALLS and PROPS (FOLIAGE only if asked). Dropping meshes to fit a
  // budget leaves holes in walls; instead the full set is decimated below (coverage-preserving clustering),
  // so the map stays complete and only coarsens. Sorted GROUND->WALLS->PROPS purely for a stable order.
  cand.sort((a, b) => (a.cat - b.cat) || (a.t - b.t));
  const chosen = [];
  for (const c of cand) {
    if (c.cat === 3 && !keepFoliage) { dropped += c.t; continue; }
    tris += c.t; chosen.push(c);
  }

  for (const c of chosen) {
    const matIndex = resolveMaterial(c.vmat);
    const hasImg = materials[matIndex] && materials[matIndex].imageIndex != null;
    for (const em of c.ctrl.embedded_meshes) {
      try { const prim = primFromMesh(c.res, em, matIndex); if (prim) { prims.push(prim); if (hasImg && prim.uv) texTris += prim.indices.length / 3; } }
      catch (e) { skipped++; }
    }
  }
  if (!prims.length) throw new Error("no world meshes in " + path.basename(file) + " (is this a Source 2 map .vpk?)");

  // Decimate the full shell to a KF-friendly triangle count without dropping any surface (no holes). The
  // gltf route DOUBLES every triangle (two-sided fix), so aim for half the budget - the doubled result
  // lands at maxTris.
  const doubling = o.twoSided !== false && o.doubleSided !== false;
  const decTarget = doubling ? Math.floor(maxTris / 2) : maxTris;
  let outPrims = prims, after = tris;
  if (tris > decTarget) {
    const { decimate } = require("../gltf/decimate");
    const r = decimate(prims, decTarget, (o.cell || process.env.KF_S2_CELL) ? { cell: +(o.cell || process.env.KF_S2_CELL) } : undefined);
    outPrims = r.prims; after = r.after;
    texTris = texTris * (after / (tris || 1));   // approximate: same textured fraction after uniform decimation
  }

  const withImg = texList.filter(Boolean).length;
  if (log) log("source 2: " + outPrims.length + " mesh(es) from " + chosen.length + "/" + cand.length + " models, " + Math.round(after) +
    " triangles" + (after < tris ? " (decimated from " + Math.round(tris) + ", coverage kept)" : "") + (dropped ? ", " + Math.round(dropped) + " foliage dropped" : "") +
    ", " + (materials.length - 1) + " material(s), " + withImg + " texture(s)" +
    (shared ? " (" + Math.round(100 * texTris / (after || 1)) + "% textured)" : ", no shared pak"));
  return { prims: outPrims, materials, lights: [], applyMat4, applyMat3, decodeMaterialImage: (i) => texList[i], vpk };
}

function convert(opts) {
  const o = Object.assign({}, opts);
  const log = o.log || (() => { });
  const scene = loadSource2Scene(o.file, log, o);
  const baseName = path.basename(o.file).replace(/\.vpk$/i, "");
  const S = o.scale || SCALE;

  // No entity spawns parsed yet: the glTF route drops one synthetic start onto the geometry near the
  // middle. Brightness follows the Source 1 route (unlit overbright would blow out otherwise).
  // Unlit static meshes render near-fullbright in KF, and de_dust2's sand/concrete are light textures, so
  // 0.57 still blew out to white in-game. Pull the texture and self-illumination down so the map reads.
  const bright = {
    texGain: o.texGain !== undefined ? o.texGain : +(process.env.KF_TEX_GAIN || 0.40),
    ambient: o.ambient !== undefined ? o.ambient : +(process.env.KF_AMBIENT || 40),
    glow: o.glow !== undefined ? o.glow : +(process.env.KF_GLOW || 20),
  };
  return gltf.convert(Object.assign({}, o, bright, {
    scene, file: null, baseName,
    axes: [0, 1, 2], flip: [0, 1, 0], scale: S,
    autoColor: o.autoColor !== false,       // textureless: colour the shell by geometry, like a model rip
    twoSided: o.twoSided !== false,         // baked world rips are single-sided - draw + collide both faces so walls/floors aren't see-through
    groundUp: false,                        // two-sided replaces the horizontal-face doubling (less geometry)
    maxTexture: o.maxTexture !== undefined ? o.maxTexture : 256,   // optimisation ranks above sharpness here (user's #1 = load/lag); UV-aware decimation already fixed the "corrupted" stretch, 256 keeps the .rom light
    cullDistance: o.cullDistance !== undefined ? o.cullDistance : +(process.env.KF_CULL_DIST || 0),
    title: baseName + " (Counter-Strike 2)",
  }));
}

module.exports = { convert, loadSource2Scene };
