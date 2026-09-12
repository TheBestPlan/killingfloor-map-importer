// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// RenderWare DFF (model) reader for GTA III / Vice City. A DFF is a tree of RW chunks
// { u32 type, u32 size, u32 libraryID }: a Clump holds a Frame List (the transform hierarchy), a
// Geometry List (the meshes) and Atomics that bind one geometry to one frame. This pulls each
// geometry's vertices, UVs and triangles (ported field-for-field from aap/librw geometry.cpp
// Geometry::streamRead), composes each atomic's frame chain into a world matrix, and returns the
// meshes already in model space. Materials/textures are read only far enough to skip; the map route
// auto-colours the geometry for now (textures live in the .txd, not decoded yet).
"use strict";

const ID_STRUCT = 0x01, ID_STRING = 0x02, ID_TEXTURE = 0x06, ID_MATERIAL = 0x07, ID_MATLIST = 0x08, ID_FRAMELIST = 0x0e, ID_GEOMETRY = 0x0f, ID_CLUMP = 0x10, ID_ATOMIC = 0x14, ID_GEOMETRYLIST = 0x1a;
const FLAG_TRISTRIP = 0x01, FLAG_TEXTURED = 0x04, FLAG_PRELIT = 0x08, FLAG_TEXTURED2 = 0x80, FLAG_NATIVE = 0x01000000;

// A cursor over the RW chunk stream.
function header(buf, off) {
  return { type: buf.readUInt32LE(off), size: buf.readUInt32LE(off + 4), version: buf.readUInt32LE(off + 8), data: off + 12 };
}
// The library ID encodes the RW version; GTA III is ~3.3-3.4, Vice City ~3.4-3.6. The <0x34000
// surface-properties quirk keys off the unpacked version number.
function unpackVersion(libid) {
  if (libid & 0xffff0000) return ((libid >> 14 & 0x3ff00) + 0x30000) | (libid >> 16 & 0x3f);
  return libid << 8;
}
function findChunk(buf, off, end, type) {
  while (off + 12 <= end) {
    const h = header(buf, off);
    if (h.type === type) return h;
    off = h.data + h.size;
  }
  return null;
}

function readGeometryStruct(buf, off, version) {
  let p = off;
  const flags = buf.readUInt32LE(p); p += 4;
  const numTriangles = buf.readUInt32LE(p); p += 4;
  const numVertices = buf.readUInt32LE(p); p += 4;
  const numMorphTargets = buf.readUInt32LE(p); p += 4;
  if (version < 0x34000) p += 12;                    // surface properties (ambient/specular/diffuse)

  let numTexSets = (flags & 0xff0000) >> 16;
  if (numTexSets === 0) numTexSets = (flags & FLAG_TEXTURED) ? 1 : (flags & FLAG_TEXTURED2) ? 2 : 0;

  const tris = [];
  const uvs = numTexSets ? new Float32Array(numVertices * 2) : null;
  if (!(flags & FLAG_NATIVE)) {
    if (flags & FLAG_PRELIT) p += numVertices * 4;    // prelit RGBA
    for (let s = 0; s < numTexSets; s++) {
      if (s === 0) { for (let i = 0; i < numVertices; i++) { uvs[i * 2] = buf.readFloatLE(p + i * 8); uvs[i * 2 + 1] = buf.readFloatLE(p + i * 8 + 4); } }
      p += numVertices * 8;
    }
    for (let i = 0; i < numTriangles; i++) {
      const t0 = buf.readUInt32LE(p), t1 = buf.readUInt32LE(p + 4); p += 8;
      tris.push([t0 >>> 16, t0 & 0xffff, t1 >>> 16, t1 & 0xffff]);  // v0, v1, v2, matId
    }
  }

  // Morph target 0 holds the vertices (and normals). Later morph targets are animation frames - skip.
  let verts = null;
  for (let m = 0; m < numMorphTargets; m++) {
    p += 16;                                          // bounding sphere
    const hasVertices = buf.readInt32LE(p); p += 4;
    const hasNormals = buf.readInt32LE(p); p += 4;
    if (hasVertices) {
      if (m === 0) { verts = new Float32Array(numVertices * 3); for (let i = 0; i < numVertices * 3; i++) verts[i] = buf.readFloatLE(p + i * 4); }
      p += numVertices * 12;
    }
    if (hasNormals) p += numVertices * 12;
  }
  return { verts, uvs, tris, numVertices };
}

// Frame list -> per-frame { name }. Only the NAMES matter: for GTA map models the engine DISCARDS the file's
// frame hierarchy entirely (re3 CFileLoader gives each kept atomic a fresh identity frame), and the frame
// names carry the LOD convention - "model_L0" is the detailed mesh, "model_L1"/"_L2" its far stand-ins
// (re3 GetNameAndLOD). The matrices in the file are the artist's staging transforms; applying them shifted
// every multi-atomic model (rail pieces 9 m apart, doubled signs, road slabs off their true spot = holes).
// Each frame's name lives in an extension chunk (NODENAME 0x253F2FE) that follows the frame-list struct,
// one extension per frame, in order.
const ID_EXTENSION = 0x03, ID_NODENAME = 0x253F2FE;
function readFrameList(buf, h) {
  const st = findChunk(buf, h.data, h.data + h.size, ID_STRUCT);
  let p = st.data;
  const n = buf.readInt32LE(p); p += 4;
  p += n * 56;                                       // 3x3 rotation + position + parent + flags, per frame
  const frames = [];
  let off = p;
  for (let i = 0; i < n; i++) {
    let name = "";
    const ex = findChunk(buf, off, h.data + h.size, ID_EXTENSION);
    if (!ex) { frames.push({ name }); continue; }
    const nn = findChunk(buf, ex.data, ex.data + ex.size, ID_NODENAME);
    if (nn) name = buf.toString("latin1", nn.data, nn.data + nn.size).replace(/\0.*$/, "");
    frames.push({ name });
    off = ex.data + ex.size;
  }
  return frames;
}

// The LOD index a frame name encodes: "foo_l2" -> 2, no suffix -> 0 (re3 GetNameAndLOD).
function lodOf(name) {
  const m = /_l(\d+)\s*$/i.exec(name || "");
  return m ? parseInt(m[1], 10) : 0;
}

// A material's { tex, rgba }: texture NAME (lowercased) or null, plus the material colour RGBA. Material
// chunk: STRUCT (flags u32, colour RGBA 4 bytes, unused u32, isTextured s32) then, if textured, a TEXTURE
// chunk holding a STRUCT + a STRING (the .txd entry name). The colour's alpha is how GTA marks glass - the
// glassfx panels carry NO texture, just a tinted, semi-transparent colour, which is why they read as flat
// grey when only the (absent) texture is looked at.
function readMaterial(buf, matH) {
  const st = findChunk(buf, matH.data, matH.data + matH.size, ID_STRUCT);
  if (!st) return { tex: null, rgba: [255, 255, 255, 255] };
  const rgba = [buf.readUInt8(st.data + 4), buf.readUInt8(st.data + 5), buf.readUInt8(st.data + 6), buf.readUInt8(st.data + 7)];
  let tex = null;
  if (buf.readInt32LE(st.data + 12)) {
    const t = findChunk(buf, matH.data, matH.data + matH.size, ID_TEXTURE);
    const nameChunk = t && findChunk(buf, t.data, t.data + t.size, ID_STRING);
    if (nameChunk) tex = buf.toString("latin1", nameChunk.data, nameChunk.data + nameChunk.size).replace(/\0.*$/, "").toLowerCase();
  }
  return { tex, rgba };
}

// A geometry's materials as { tex, rgba }, in material order (the triangle matId indexes this).
function readMaterialList(buf, geomH) {
  const ml = findChunk(buf, geomH.data, geomH.data + geomH.size, ID_MATLIST);
  if (!ml) return [];
  const st = findChunk(buf, ml.data, ml.data + ml.size, ID_STRUCT);
  const numMat = buf.readInt32LE(st.data);
  const indices = []; for (let i = 0; i < numMat; i++) indices.push(buf.readInt32LE(st.data + 4 + i * 4));
  const mats = [];
  let off = st.data + st.size;
  for (let i = 0; i < numMat; i++) {
    if (indices[i] >= 0) { mats.push(mats[indices[i]] || { tex: null, rgba: [255, 255, 255, 255] }); continue; }
    const matH = findChunk(buf, off, ml.data + ml.size, ID_MATERIAL);
    if (!matH) { mats.push({ tex: null, rgba: [255, 255, 255, 255] }); continue; }
    mats.push(readMaterial(buf, matH));
    off = matH.data + matH.size;
  }
  return mats;
}

// Parse a DFF into { geometries: [{verts, uvs, tris, materials}] } already placed by their atomic's frame.
function readDff(buf) {
  const clump = header(buf, 0);
  if (clump.type !== ID_CLUMP) throw new Error("not a DFF (first chunk 0x" + clump.type.toString(16) + ")");
  const end = clump.data + clump.size;

  const frameListH = findChunk(buf, clump.data, end, ID_FRAMELIST);
  const frames = frameListH ? readFrameList(buf, frameListH) : [];

  const glH = findChunk(buf, clump.data, end, ID_GEOMETRYLIST);
  const geometries = [];
  if (glH) {
    const st = findChunk(buf, glH.data, glH.data + glH.size, ID_STRUCT);
    const numGeom = buf.readInt32LE(st.data);
    let off = st.data + st.size;
    for (let g = 0; g < numGeom; g++) {
      const gh = findChunk(buf, off, glH.data + glH.size, ID_GEOMETRY);
      if (!gh) break;
      const gst = findChunk(buf, gh.data, gh.data + gh.size, ID_STRUCT);
      const geo = readGeometryStruct(buf, gst.data, unpackVersion(gh.version));
      geo.materials = readMaterialList(buf, gh);
      geometries.push(geo);
      off = gh.data + gh.size;
    }
  }

  // Atomics bind geometry index -> frame index. A multi-atomic map model is a LOD SET, not a multi-part
  // mesh: the frame names run "model_L0" (detail) / "_L1" (far stand-in), the engine draws ONE of them by
  // distance and gives it a fresh identity frame. So: keep only the lowest-LOD atomics and take their
  // geometry raw - no frame transform (drawing every atomic at its staging offset doubled signs, tore the
  // elevated rail apart and slid road slabs off their spot, leaving holes).
  const atomics = [];
  let ao = clump.data;
  while (true) {
    const at = findChunk(buf, ao, end, ID_ATOMIC);
    if (!at) break;
    const st = findChunk(buf, at.data, at.data + at.size, ID_STRUCT);
    const frameIndex = buf.readInt32LE(st.data);
    const geomIndex = buf.readInt32LE(st.data + 4);
    const geo = geometries[geomIndex];
    if (geo && geo.verts) atomics.push({ geo, lod: lodOf(frames[frameIndex] && frames[frameIndex].name) });
    ao = at.data + at.size;
  }
  const placed = [];
  if (atomics.length) {
    const minLod = Math.min(...atomics.map((a) => a.lod));
    for (const a of atomics) if (a.lod === minLod) placed.push({ verts: a.geo.verts, uvs: a.geo.uvs, tris: a.geo.tris, materials: a.geo.materials });
  } else {
    for (const geo of geometries) if (geo.verts) placed.push({ verts: geo.verts, uvs: geo.uvs, tris: geo.tris, materials: geo.materials });
  }
  return { geometries: placed };
}

module.exports = { readDff };
