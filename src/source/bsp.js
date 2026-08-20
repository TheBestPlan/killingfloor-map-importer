// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Source engine BSP (VBSP) reader -> the same scene shape the glTF route consumes.
//
// Covers Source 1 maps: Counter-Strike: Source / CS:GO (v19-21), Half-Life 2, Garry's Mod, Left 4
// Dead (all VBSP). It reads every brush model's faces (world + doors/windows/breakables/func_brush),
// their texinfo UVs, VTF/VMT materials (with $alphatest/$translucent/$nocull carried as cut-out and
// two-sided flags), displacements, and static props, and returns
// { prims, materials, lights, propModels, propInstances, spawns, decodeMaterialImage, ... } - so
// src/gltf builds the .rom from it exactly like a 3D model. Source is Z-up like GoldSrc, so the route
// feeds axes [0,1,2] with a Y flip. Tool surfaces (sky, nodraw, skip, hint, trigger) are dropped.
"use strict";

const fs = require("fs");
const { decodeLump, isValveLzma } = require("./lzma");
const { Zip } = require("./zip");
const { decodeVtf } = require("./vtf");
const { parseVmt } = require("./vmt");
const { loadModel } = require("./mdl");

const LUMP = { ENTITIES: 0, PLANES: 1, TEXDATA: 2, VERTEXES: 3, TEXINFO: 6, FACES: 7, EDGES: 12, SURFEDGES: 13, MODELS: 14, DISPINFO: 26, DISP_VERTS: 33, GAME_LUMP: 35, PAKFILE: 40, TEXDATA_STRING_DATA: 43, TEXDATA_STRING_TABLE: 44 };
// texinfo flags that mean "not a drawable world surface"
const SURF_SKIP_MASK = 0x4 /*sky*/ | 0x40 /*trigger*/ | 0x80 /*nodraw*/ | 0x100 /*hint*/ | 0x200 /*skip*/ | 0x2 /*sky2d*/;
// A tool/editor material (tools/toolstrigger, toolsclip, toolsnodraw, ...). Reading brush-entity models
// pulls in trigger and clip brushes whose texinfo does not always carry the matching SURF flag, so the
// visible "TRIGGER" texture leaked onto the map - drop them by name as a backstop to the flag test.
const TOOL_TEX = /^tools[\\/]/i;

function readLumps(buf) {
  const magic = buf.toString("latin1", 0, 4);
  if (magic !== "VBSP") throw new Error("not a Source BSP (magic " + magic + ")");
  const version = buf.readInt32LE(4);
  // lump_t is normally { fileofs, filelen, version, fourCC }, but the Left 4 Dead 2 engine branch
  // swapped it to { version, fileofs, filelen, fourCC }. Detect which by counting how many lumps land
  // at a plausible file offset under each reading, and take the better one.
  const raw = [];
  for (let i = 0; i < 64; i++) { const o = 8 + i * 16; raw.push([buf.readInt32LE(o), buf.readInt32LE(o + 4), buf.readInt32LE(o + 8)]); }
  const size = buf.length;
  const std = (r) => ({ ofs: r[0], len: r[1], ver: r[2] });
  const l4d = (r) => ({ ofs: r[1], len: r[2], ver: r[0] });
  const score = (pick) => raw.reduce((n, r) => { const p = pick(r); return n + (p.len > 0 && p.ofs >= 8 && p.ofs + p.len <= size ? 1 : 0); }, 0);
  const pick = score(l4d) > score(std) ? l4d : std;
  return { version, lumps: raw.map(pick) };
}
// A lump may be individually LZMA-compressed (common in Left 4 Dead 2 / CS:GO): decode transparently.
function lumpBuf(buf, lumps, id) {
  const raw = buf.subarray(lumps[id].ofs, lumps[id].ofs + lumps[id].len);
  return isValveLzma(raw, 0) ? decodeLump(raw) : raw;
}

function cString(buf, off) { let e = off; while (e < buf.length && buf[e] !== 0) e++; return buf.toString("latin1", off, e); }

// A stable colour per material name, so the flat-shaded map still reads as distinct surfaces until
// the VTF texture pipeline lands.
function hashColor(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
  const r = 90 + (h & 0x7f), g = 90 + ((h >> 8) & 0x7f), b = 90 + ((h >> 16) & 0x7f);
  return [r / 255, g / 255, b / 255, 1];
}

// GAME_LUMP sprp -> static prop placements { model, origin, angles }.
function readStaticProps(buf, lumps) {
  const gl = lumps[LUMP.GAME_LUMP];
  if (!gl || !gl.len || gl.ofs <= 0 || gl.ofs + gl.len > buf.length) return [];
  let p = gl.ofs; const count = buf.readInt32LE(p); p += 4;
  let sprp = null;
  for (let i = 0; i < count && i < 64; i++) {
    const id = buf.toString("latin1", p, p + 4).split("").reverse().join("");
    if (id === "sprp") sprp = { ofs: buf.readInt32LE(p + 8), len: buf.readInt32LE(p + 12) };
    p += 16;
  }
  if (!sprp || sprp.ofs <= 0 || sprp.ofs + sprp.len > buf.length) return [];
  let q = sprp.ofs;
  const nDict = buf.readInt32LE(q); q += 4;
  if (nDict < 0 || nDict > 100000) return [];
  const names = [];
  for (let i = 0; i < nDict; i++) { names.push(buf.toString("latin1", q, q + 128).replace(/\0.*$/, "").replace(/\\/g, "/")); q += 128; }
  const nLeaf = buf.readInt32LE(q); q += 4; q += nLeaf * 2;
  const nProp = buf.readInt32LE(q); q += 4;
  if (nProp <= 0 || nProp > 1000000) return [];
  const entrySize = Math.floor((sprp.ofs + sprp.len - q) / nProp);
  if (entrySize < 24) return [];
  const props = [];
  for (let i = 0; i < nProp; i++) {
    const o = q + i * entrySize;
    const t = buf.readUInt16LE(o + 24);
    // Solid @30 is stable across StaticPropLump versions 4-11: 0 = SOLID_NONE (foliage the player walks
    // through), 2/6 = a real collision hull. Carried so the .rom writer can drop collision on grass.
    const solid = entrySize > 30 ? buf.readUInt8(o + 30) : 6;
    if (names[t]) props.push({ model: names[t], origin: [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)], angles: [buf.readFloatLE(o + 12), buf.readFloatLE(o + 16), buf.readFloatLE(o + 20)], solid });
  }
  return props;
}

// Source QAngle (pitch, yaw, roll degrees) -> rotation matrix[row][col] (Source AngleMatrix).
function angleMatrix(a) {
  const d = Math.PI / 180;
  const sp = Math.sin(a[0] * d), cp = Math.cos(a[0] * d);
  const sy = Math.sin(a[1] * d), cy = Math.cos(a[1] * d);
  const sr = Math.sin(a[2] * d), cr = Math.cos(a[2] * d);
  return [
    [cp * cy, sr * sp * cy - cr * sy, cr * sp * cy + sr * sy],
    [cp * sy, sr * sp * sy + cr * cy, cr * sp * sy - sr * cy],
    [-sp, sr * cp, cr * cp],
  ];
}

function loadSourceScene(file, log, opts) {
  opts = opts || {};
  const buf = fs.readFileSync(file);
  const { version, lumps } = readLumps(buf);

  // Textures: a material's .vmt/.vtf come from the map's own PAKFILE lump (embedded, e.g. a Garry's
  // Mod DBD port) or the game's VPKs. A material name has no "materials/" prefix and no extension.
  const pakZip = new Zip(lumpBuf(buf, lumps, LUMP.PAKFILE));
  const gameVpks = opts.gameVpks || null;
  const readContent = (p) => pakZip.read(p) || (gameVpks && gameVpks.read(p)) || null;
  // Resolve a material to { img, translucent, alphatest, nocull } - the decoded VTF plus the render
  // flags the .rom writer needs to cut foliage out ($alphatest/$translucent) and draw it two-sided
  // ($nocull). A "patch" material's flags are OR'd with the material it includes.
  const resolveVmtPath = (vmtPath) => {
    const vmt = readContent(vmtPath);
    if (!vmt) return null;
    let kv = parseVmt(vmt.toString("latin1"));
    let translucent = kv.translucent, alphatest = kv.alphatest, nocull = kv.nocull;
    if (!kv.basetexture && kv.include) {
      const inc = readContent(kv.include);
      if (inc) { kv = parseVmt(inc.toString("latin1")); translucent = translucent || kv.translucent; alphatest = alphatest || kv.alphatest; nocull = nocull || kv.nocull; }
    }
    const base = kv.basetexture || vmtPath.replace(/^materials\//i, "").replace(/\.vmt$/i, "");
    const vtf = readContent("materials/" + base.replace(/\.vtf$/i, "") + ".vtf");
    if (!vtf) return null;
    let img = null; try { img = decodeVtf(vtf); } catch (e) { img = null; }
    if (!img) return null;
    return { img, translucent, alphatest, nocull };
  };
  const resolveTexture = (name) => resolveVmtPath("materials/" + name + ".vmt");
  // A prop material has no path; its .vmt sits under one of the model's cdtexture dirs.
  const resolvePropTexture = (name, dirs) => {
    for (const d of dirs) { const r = resolveVmtPath("materials/" + d + name + ".vmt"); if (r) return r; }
    return resolveVmtPath("materials/" + name + ".vmt");
  };
  // One material per texdata/prop name. A textured material carries the cut-out/two-sided flags so
  // the .rom writer can pick STY_Masked + bTwoSided; an unresolved one falls back to a hashed colour.
  const getMaterial = (name, resolveFn) => {
    let mi = matIndex.get(name);
    if (mi !== undefined) return mi;
    mi = materials.length; matIndex.set(name, mi);
    const res = resolveFn();
    if (res && res.img) {
      materials.push({ name, factor: [1, 1, 1, 1], imageIndex: mi, mask: !!(res.alphatest || res.translucent), twoSided: !!res.nocull });
      texImages[mi] = res.img; stats.textured++;
    } else {
      materials.push({ name, factor: hashColor(name), imageIndex: null });
      texImages[mi] = null;
    }
    return mi;
  };

  const verts = lumpBuf(buf, lumps, LUMP.VERTEXES);        // FVector[]
  const nVerts = verts.length / 12;
  const vert = (i) => [verts.readFloatLE(i * 12), verts.readFloatLE(i * 12 + 4), verts.readFloatLE(i * 12 + 8)];

  const edgesB = lumpBuf(buf, lumps, LUMP.EDGES);          // u16[2][]
  const edge = (i) => [edgesB.readUInt16LE(i * 4), edgesB.readUInt16LE(i * 4 + 2)];
  const surfedges = lumpBuf(buf, lumps, LUMP.SURFEDGES);   // i32[]
  const nSurfedges = surfedges.length / 4;

  const planesB = lumpBuf(buf, lumps, LUMP.PLANES);        // normal(12)+dist(4)+type(4) = 20
  const planeNormal = (i) => [planesB.readFloatLE(i * 20), planesB.readFloatLE(i * 20 + 4), planesB.readFloatLE(i * 20 + 8)];

  // texinfo: textureVecs[2][4] (32) + lightmapVecs[2][4] (32) + flags(4) + texdata(4) = 72
  const texinfoB = lumpBuf(buf, lumps, LUMP.TEXINFO);
  const texinfo = (i) => {
    const o = i * 72;
    return {
      s: [texinfoB.readFloatLE(o), texinfoB.readFloatLE(o + 4), texinfoB.readFloatLE(o + 8), texinfoB.readFloatLE(o + 12)],
      t: [texinfoB.readFloatLE(o + 16), texinfoB.readFloatLE(o + 20), texinfoB.readFloatLE(o + 24), texinfoB.readFloatLE(o + 28)],
      flags: texinfoB.readInt32LE(o + 64), texdata: texinfoB.readInt32LE(o + 68),
    };
  };
  // texdata: reflectivity(12) + nameStringTableID(4) + width(4) + height(4) + view_w(4) + view_h(4) = 32
  const texdataB = lumpBuf(buf, lumps, LUMP.TEXDATA);
  const texdata = (i) => ({ nameId: texdataB.readInt32LE(i * 32 + 12), width: texdataB.readInt32LE(i * 32 + 16), height: texdataB.readInt32LE(i * 32 + 20) });
  const strTable = lumpBuf(buf, lumps, LUMP.TEXDATA_STRING_TABLE);
  const strData = lumpBuf(buf, lumps, LUMP.TEXDATA_STRING_DATA);
  const texName = (nameId) => cString(strData, strTable.readInt32LE(nameId * 4));

  // face: planenum(u16) side(u8) onNode(u8) firstedge(i32) numedges(i16) texinfo(i16) dispinfo(i16)
  //       surfaceFogVolumeID(i16) styles[4](u8) lightofs(i32) area(f32) lmMins[2](i32) lmSize[2](i32)
  //       origFace(i32) numPrims(u16) firstPrimID(u16) smoothingGroups(u32) = 56
  const facesB = lumpBuf(buf, lumps, LUMP.FACES);
  const FACE = 56;
  const nFaces = facesB.length / FACE;
  const face = (i) => {
    const o = i * FACE;
    return { planenum: facesB.readUInt16LE(o), side: facesB[o + 2], firstedge: facesB.readInt32LE(o + 4), numedges: facesB.readInt16LE(o + 8), texinfo: facesB.readInt16LE(o + 10), dispinfo: facesB.readInt16LE(o + 12) };
  };

  // dmodel_t (48): mins(12) maxs(12) origin(12) headnode(4) firstface(4)@40 numfaces(4)@44
  const modelsB = lumpBuf(buf, lumps, LUMP.MODELS);

  // Winding: gather the face's polygon vertices via surfedges -> edges -> vertexes.
  // Displacements: ddispinfo_t (176 bytes) builds a subdivided grid on a base quad face; dDispVert
  // (20 bytes) carries each grid point's offset direction + distance.
  const dispinfoB = lumpBuf(buf, lumps, LUMP.DISPINFO);
  const dispinfo = (i) => ({ startPos: [dispinfoB.readFloatLE(i * 176), dispinfoB.readFloatLE(i * 176 + 4), dispinfoB.readFloatLE(i * 176 + 8)], vertStart: dispinfoB.readInt32LE(i * 176 + 12), power: dispinfoB.readInt32LE(i * 176 + 20) });
  const dispvertsB = lumpBuf(buf, lumps, LUMP.DISP_VERTS);
  const dispVert = (i) => ({ vec: [dispvertsB.readFloatLE(i * 20), dispvertsB.readFloatLE(i * 20 + 4), dispvertsB.readFloatLE(i * 20 + 8)], dist: dispvertsB.readFloatLE(i * 20 + 12) });

  const faceVerts = (f) => {
    const out = [];
    for (let k = 0; k < f.numedges; k++) {
      const se = surfedges.readInt32LE((f.firstedge + k) * 4);
      const e = edge(Math.abs(se));
      out.push(se >= 0 ? e[0] : e[1]);
    }
    return out;
  };

  // Group faces by material (texdata), build one prim per material.
  const groups = new Map();
  const materials = [];
  const matIndex = new Map();
  const texImages = [];
  const stats = { faces: 0, tris: 0, skipped: 0, tool: 0, disp: 0, textured: 0 };
  const groupOf = (mi) => { let g = groups.get(mi); if (!g) { g = { pos: [], nrm: [], uv: [] }; groups.set(mi, g); } return g; };

  const emitFace = (fi) => {
    const f = face(fi);
    if (f.dispinfo >= 0) {
      const corners = faceVerts(f);
      if (corners.length !== 4 || f.texinfo < 0) { stats.skipped++; return; }
      const ti = texinfo(f.texinfo);
      if (ti.flags & SURF_SKIP_MASK) { stats.tool++; return; }
      const td = texdata(ti.texdata);
      const name = texName(td.nameId);
      if (TOOL_TEX.test(name)) { stats.tool++; return; }
      const g = groupOf(getMaterial(name, () => resolveTexture(name)));
      const di = dispinfo(f.dispinfo);
      const C = corners.map(vert);
      let best = 0, bestD = Infinity;
      for (let k = 0; k < 4; k++) { const dx = C[k][0] - di.startPos[0], dy = C[k][1] - di.startPos[1], dz = C[k][2] - di.startPos[2]; const d = dx * dx + dy * dy + dz * dz; if (d < bestD) { bestD = d; best = k; } }
      const c = [0, 1, 2, 3].map((k) => C[(best + k) % 4]);
      const tw = td.width || 1, th = td.height || 1;
      const uvOf = (p) => [(ti.s[0] * p[0] + ti.s[1] * p[1] + ti.s[2] * p[2] + ti.s[3]) / tw, (ti.t[0] * p[0] + ti.t[1] * p[1] + ti.t[2] * p[2] + ti.t[3]) / th];
      const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      const nn = 1 << di.power, size = nn + 1;
      const grid = new Array(size * size);
      for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) {
        const flat = lerp(lerp(c[0], c[1], i / nn), lerp(c[3], c[2], i / nn), j / nn);
        const dv = dispVert(di.vertStart + i * size + j);
        grid[i * size + j] = { pos: [flat[0] + dv.vec[0] * dv.dist, flat[1] + dv.vec[1] * dv.dist, flat[2] + dv.vec[2] * dv.dist], uv: uvOf(flat) };
      }
      const triN = (a, b, cc) => { const ux = b.pos[0] - a.pos[0], uy = b.pos[1] - a.pos[1], uz = b.pos[2] - a.pos[2], vx = cc.pos[0] - a.pos[0], vy = cc.pos[1] - a.pos[1], vz = cc.pos[2] - a.pos[2]; const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1; return [nx / l, ny / l, nz / l]; };
      const pushTri = (a, b, cc) => { const nm = triN(a, b, cc); for (const v of [a, b, cc]) { g.pos.push(v.pos[0], v.pos[1], v.pos[2]); g.nrm.push(nm[0], nm[1], nm[2]); g.uv.push(v.uv[0], v.uv[1]); } stats.tris++; };
      for (let i = 0; i < nn; i++) for (let j = 0; j < nn; j++) {
        const a = grid[i * size + j], b = grid[i * size + j + 1], cc = grid[(i + 1) * size + j], d = grid[(i + 1) * size + j + 1];
        pushTri(a, cc, b); pushTri(b, cc, d);
      }
      stats.disp++;
      return;
    }
    if (f.texinfo < 0) { stats.skipped++; return; }
    const ti = texinfo(f.texinfo);
    if (ti.flags & SURF_SKIP_MASK) { stats.tool++; return; }
    const td = texdata(ti.texdata);
    const name = texName(td.nameId);
    if (TOOL_TEX.test(name)) { stats.tool++; return; }
    const g = groupOf(getMaterial(name, () => resolveTexture(name)));

    const vi = faceVerts(f);
    if (vi.length < 3) { stats.skipped++; return; }
    let normal = planeNormal(f.planenum);
    if (f.side) normal = [-normal[0], -normal[1], -normal[2]];
    const tw = td.width || 1, th = td.height || 1;
    const uvOf = (p) => [(ti.s[0] * p[0] + ti.s[1] * p[1] + ti.s[2] * p[2] + ti.s[3]) / tw, (ti.t[0] * p[0] + ti.t[1] * p[1] + ti.t[2] * p[2] + ti.t[3]) / th];
    const P = vi.map(vert);
    const UV = P.map(uvOf);
    // fan triangulate; expand per corner (mesh.js re-chunks anyway)
    for (let k = 1; k + 1 < P.length; k++) {
      for (const idx of [0, k, k + 1]) {
        g.pos.push(P[idx][0], P[idx][1], P[idx][2]);
        g.nrm.push(normal[0], normal[1], normal[2]);
        g.uv.push(UV[idx][0], UV[idx][1]);
      }
      stats.tris++;
    }
    stats.faces++;
  };

  // Every brush model, not just world model 0: doors, windows, breakables, func_brush/detail decoration
  // are separate models (info from the map's entity lump), and skipping them left the wall openings they
  // fill as holes (cs_italy's steel doors, dust2's window frames). Tool surfaces on them - triggers,
  // clips, nodraw - are dropped by the same SURF flag test, so only visible geometry comes through.
  const nModels = Math.floor(modelsB.length / 48);
  for (let m = 0; m < nModels; m++) {
    const ff = modelsB.readInt32LE(m * 48 + 40), nf = modelsB.readInt32LE(m * 48 + 44);
    if (nf <= 0 || ff < 0 || ff + nf > nFaces) continue;
    for (let fi = ff; fi < ff + nf; fi++) emitFace(fi);
  }
  stats.models = nModels;

  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const prims = [];
  for (const [mi, g] of groups) {
    if (!g.pos.length) continue;
    const n = g.pos.length / 3;
    prims.push({ pos: { data: g.pos, count: n }, nrm: { data: g.nrm, count: n }, uv: { data: g.uv, count: g.uv.length / 2 }, indices: Array.from({ length: n }, (_, i) => i), material: mi, matrix: identity });
  }

  // --- static props (prop_static) -----------------------------------------------------------------
  // A Garry's Mod map is mostly props: the visible structures are external .mdl models placed by the
  // GAME_LUMP's sprp sub-lump. Load each unique model once and instance it at every placement. Kept
  // under a triangle budget so a foliage-heavy realm does not overwhelm the target engine.
  // Each unique model is loaded once (source-local geometry + resolved materials); every placement is
  // a lightweight instance. The KF transform (mirror + scale + the per-instance rotator) is applied
  // downstream in src/source/convert.js so one StaticMesh is shared by every instance.
  stats.props = 0; stats.propModels = 0; stats.propTris = 0; stats.propsSkipped = 0;
  const propModels = [];              // { verts:[{pos,normal,uv}], submeshes:[{material, indices}] } source-local
  const propModelIndex = new Map();   // model name -> index into propModels (-1 = failed to load)
  const propInstances = [];           // { model: index, origin, angles }
  if (opts.props !== false) {
    try {
      const props = readStaticProps(buf, lumps);
      const PROP_LOD = +(process.env.KF_PROP_LOD || 2);
      const cache = new Map();
      const loadCached = (name) => {
        if (cache.has(name)) return cache.get(name);
        const mdl = readContent(name), vvd = readContent(name.replace(/\.mdl$/i, ".vvd")),
          vtx = readContent(name.replace(/\.mdl$/i, ".dx90.vtx")) || readContent(name.replace(/\.mdl$/i, ".vtx"));
        let model = null; try { model = loadModel(mdl, vvd, vtx, PROP_LOD); } catch (e) { model = null; }
        cache.set(name, model); return model;
      };
      const registerModel = (name) => {
        if (propModelIndex.has(name)) return propModelIndex.get(name);
        const model = loadCached(name);
        if (!model) { propModelIndex.set(name, -1); return -1; }
        const submeshes = [];
        for (const mesh of model.meshes) {
          const mn = mesh.material || "prop";
          const mi = getMaterial(mn, () => resolvePropTexture(mn, model.cdtextures || []));
          submeshes.push({ material: mi, indices: mesh.indices });
          stats.propTris += mesh.indices.length / 3;
        }
        const idx = propModels.length;
        propModels.push({ verts: model.verts, submeshes });
        propModelIndex.set(name, idx); stats.propModels++;
        return idx;
      };
      for (const pr of props) {
        const mIdx = registerModel(pr.model);
        if (mIdx < 0) { stats.propsSkipped++; continue; }
        propInstances.push({ model: mIdx, origin: pr.origin, angles: pr.angles, solid: pr.solid });
        stats.props++;
      }
    } catch (e) { if (log) log("props: " + e.message); }
  }

  const applyMat4 = (m, p) => p;               // Source verts are already world-space, matrix is identity
  const applyMat3 = (m, n) => n;
  const decodeMaterialImage = (mi) => texImages[mi];

  // Player starts from the entity lump (text KeyValues, like GoldSrc). Every Source game names them
  // differently; take any info_player_* / survivor spawn.
  const spawns = [];
  const entText = lumpBuf(buf, lumps, LUMP.ENTITIES).toString("latin1");
  const SPAWN = /^(info_player_(start|terrorist|counterterrorist|deathmatch|rebel|combine|teamspawn|logo)|info_survivor_position|info_player_spawn)$/i;
  for (const block of entText.split("}")) {
    const cls = /"classname"\s*"([^"]+)"/i.exec(block);
    if (!cls || !SPAWN.test(cls[1])) continue;
    const org = /"origin"\s*"([^"]+)"/i.exec(block);
    if (!org) continue;
    const o = org[1].trim().split(/\s+/).map(Number);
    const ang = /"angles"\s*"([^"]+)"/i.exec(block);
    const yaw = ang ? (parseFloat(ang[1].trim().split(/\s+/)[1]) || 0) : 0;
    spawns.push({ origin: [o[0] || 0, o[1] || 0, o[2] || 0], yaw });
  }

  if (log) log("Source BSP v" + version + ": " + stats.faces + " world faces -> " + stats.tris + " tris, " +
    stats.props + " props of " + stats.propModels + " model(s) -> " + Math.round(stats.propTris) + " tris" + (stats.propsSkipped ? " (" + stats.propsSkipped + " over budget/missing)" : "") +
    ", " + materials.length + " material(s), " + stats.textured + " textured, " + spawns.length + " spawn(s)");
  return { prims, materials, lights: [], spawns, propModels, propInstances, decodeMaterialImage, applyMat4, applyMat3, version, stats };
}

module.exports = { loadSourceScene, readLumps, angleMatrix };
