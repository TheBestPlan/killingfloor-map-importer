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

// Frame list -> per-frame local matrix (RW stores rotation as 3 row-vectors + position) and parent.
function readFrameList(buf, h) {
  const st = findChunk(buf, h.data, h.data + h.size, ID_STRUCT);
  let p = st.data;
  const n = buf.readInt32LE(p); p += 4;
  const frames = [];
  for (let i = 0; i < n; i++) {
    const r = []; for (let k = 0; k < 9; k++) { r.push(buf.readFloatLE(p)); p += 4; }
    const pos = [buf.readFloatLE(p), buf.readFloatLE(p + 4), buf.readFloatLE(p + 8)]; p += 12;
    const parent = buf.readInt32LE(p); p += 4; p += 4;   // parent, flags
    frames.push({ r, pos, parent });
  }
  return frames;
}

// Compose a frame's local matrix up its parent chain into a world 3x4 (rotation rows + translation).
function frameMatrix(frames, idx) {
  const chain = [];
  let i = idx;
  while (i >= 0 && i < frames.length) { chain.unshift(frames[i]); const par = frames[i].parent; if (par === i || par < 0) break; i = par; }
  // start with identity
  let m = [1, 0, 0, 0, 1, 0, 0, 0, 1], t = [0, 0, 0];
  for (const f of chain) {
    const fr = f.r, fp = f.pos;
    // world = parent * local: rotate local rotation by current, translate
    const nm = new Array(9), nt = [0, 0, 0];
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
      nm[row * 3 + col] = fr[row * 3 + 0] * m[0 * 3 + col] + fr[row * 3 + 1] * m[1 * 3 + col] + fr[row * 3 + 2] * m[2 * 3 + col];
    }
    for (let col = 0; col < 3; col++) nt[col] = fp[0] * m[0 * 3 + col] + fp[1] * m[1 * 3 + col] + fp[2] * m[2 * 3 + col] + t[col];
    m = nm; t = nt;
  }
  return { m, t };
}

// The matrix to place one atomic's geometry. Normally the frame's LTM, BUT when the atomic's frame carries
// a ROTATION (only 8 GTA III map models - the bar_/gdyn_ barriers and proj_garage doors), that rotation must
// be dropped: those models are authored in a twisted frame and their IPL instance quaternion already carries
// the true orientation, so baking the frame twist too lays the mesh on its side (a 10 m guardrail flat across
// the pavement). The frame's world TRANSLATION is kept - it positions multi-part meshes.
function atomicMatrix(frames, idx) {
  const m = frameMatrix(frames, idx);
  const ident = Math.abs(m.m[0] - 1) < 1e-4 && Math.abs(m.m[4] - 1) < 1e-4 && Math.abs(m.m[8] - 1) < 1e-4 &&
    Math.abs(m.m[1]) < 1e-4 && Math.abs(m.m[2]) < 1e-4 && Math.abs(m.m[3]) < 1e-4;
  return ident ? m : { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: m.t };
}

function transformVerts(verts, mat) {
  const { m, t } = mat;
  const out = new Float32Array(verts.length);
  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    out[i] = x * m[0] + y * m[3] + z * m[6] + t[0];
    out[i + 1] = x * m[1] + y * m[4] + z * m[7] + t[1];
    out[i + 2] = x * m[2] + y * m[5] + z * m[8] + t[2];
  }
  return out;
}

// A material's texture NAME (lowercased) or null. Material chunk: STRUCT (flags, RGBA, unused,
// textured) then, if textured, a TEXTURE chunk holding a STRUCT + a STRING (the .txd entry name).
function readMaterialTexture(buf, matH) {
  const st = findChunk(buf, matH.data, matH.data + matH.size, ID_STRUCT);
  if (!st) return null;
  const textured = buf.readInt32LE(st.data + 12);
  if (!textured) return null;
  const tex = findChunk(buf, matH.data, matH.data + matH.size, ID_TEXTURE);
  if (!tex) return null;
  const nameChunk = findChunk(buf, tex.data, tex.data + tex.size, ID_STRING);
  if (!nameChunk) return null;
  return buf.toString("latin1", nameChunk.data, nameChunk.data + nameChunk.size).replace(/\0.*$/, "").toLowerCase();
}

// A geometry's material texture names, in material order (the triangle matId indexes this).
function readMaterialList(buf, geomH) {
  const ml = findChunk(buf, geomH.data, geomH.data + geomH.size, ID_MATLIST);
  if (!ml) return [];
  const st = findChunk(buf, ml.data, ml.data + ml.size, ID_STRUCT);
  const numMat = buf.readInt32LE(st.data);
  const indices = []; for (let i = 0; i < numMat; i++) indices.push(buf.readInt32LE(st.data + 4 + i * 4));
  const names = [];
  let off = st.data + st.size;
  for (let i = 0; i < numMat; i++) {
    if (indices[i] >= 0) { names.push(names[indices[i]] || null); continue; }
    const matH = findChunk(buf, off, ml.data + ml.size, ID_MATERIAL);
    if (!matH) { names.push(null); continue; }
    names.push(readMaterialTexture(buf, matH));
    off = matH.data + matH.size;
  }
  return names;
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

  // Atomics bind geometry index -> frame index. No atomics (or none matched): leave geometry in place.
  const placed = [];
  let ao = clump.data;
  let matched = false;
  while (true) {
    const at = findChunk(buf, ao, end, ID_ATOMIC);
    if (!at) break;
    const st = findChunk(buf, at.data, at.data + at.size, ID_STRUCT);
    const frameIndex = buf.readInt32LE(st.data);
    const geomIndex = buf.readInt32LE(st.data + 4);
    const geo = geometries[geomIndex];
    if (geo && geo.verts) { placed.push({ verts: transformVerts(geo.verts, atomicMatrix(frames, frameIndex)), uvs: geo.uvs, tris: geo.tris, materials: geo.materials }); matched = true; }
    ao = at.data + at.size;
  }
  if (!matched) for (const geo of geometries) if (geo.verts) placed.push({ verts: geo.verts, uvs: geo.uvs, tris: geo.tris, materials: geo.materials });
  return { geometries: placed };
}

module.exports = { readDff };
