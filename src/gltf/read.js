// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// glTF 2.0 / GLB reader.
//
// The input for the "3D model" route: a scene exported to glTF/GLB (from Sketchfab, CGTrader, a
// Blender .blend, an Open3DLab rip, or a decompiled Source map). Reads the subset a static level
// needs: node transforms, POSITION/NORMAL/TEXCOORD_0, indices, pbrMetallicRoughness base colour, and
// KHR_lights_punctual. Skins/animation/morphs/draco are ignored - a level export carries none.
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const GLB_MAGIC = 0x46546c67;   // "glTF"
const CHUNK_JSON = 0x4e4f534a;  // "JSON"
const CHUNK_BIN = 0x004e4942;   // "BIN\0"

const COMP = {
  5120: [1, "getInt8"], 5121: [1, "getUint8"], 5122: [2, "getInt16"],
  5123: [2, "getUint16"], 5125: [4, "getUint32"], 5126: [4, "getFloat32"],
};
const NUMC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function loadDocument(file) {
  const buf = fs.readFileSync(file);
  if (buf.length >= 12 && buf.readUInt32LE(0) === GLB_MAGIC) {
    let json = null, bin = null, p = 12;
    while (p + 8 <= buf.length) {
      const len = buf.readUInt32LE(p), type = buf.readUInt32LE(p + 4);
      const data = buf.subarray(p + 8, p + 8 + len);
      if (type === CHUNK_JSON) json = JSON.parse(data.toString("utf8"));
      else if (type === CHUNK_BIN) bin = data;
      p += 8 + len;
    }
    if (!json) throw new Error("GLB has no JSON chunk");
    return { gltf: json, glbBin: bin, dir: path.dirname(file) };
  }
  return { gltf: JSON.parse(buf.toString("utf8")), glbBin: null, dir: path.dirname(file) };
}

function decodeDataUri(uri) {
  const m = /^data:([^;,]*)?(;base64)?,(.*)$/s.exec(uri);
  if (!m) return null;
  return m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "latin1");
}

function resolveBuffers(doc) {
  return (doc.gltf.buffers || []).map((b, i) => {
    if (!b.uri) { if (!doc.glbBin) throw new Error("buffer " + i + " has no uri and no GLB BIN"); return doc.glbBin; }
    if (/^data:/.test(b.uri)) return decodeDataUri(b.uri);
    return fs.readFileSync(path.join(doc.dir, decodeURIComponent(b.uri)));
  });
}

function readAccessor(gltf, buffers, index) {
  const acc = gltf.accessors[index];
  const [bytes, reader] = COMP[acc.componentType];
  const numc = NUMC[acc.type];
  const out = new Array(acc.count * numc);
  if (acc.bufferView === undefined) { out.fill(0); return { data: out, numc, count: acc.count }; }
  const bv = gltf.bufferViews[acc.bufferView];
  const buf = buffers[bv.buffer];
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || bytes * numc;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < numc; c++) {
      let v = dv[reader](base + i * stride + c * bytes, true);
      if (acc.normalized) {
        if (acc.componentType === 5121) v /= 255; else if (acc.componentType === 5123) v /= 65535;
        else if (acc.componentType === 5120) v = Math.max(v / 127, -1); else if (acc.componentType === 5122) v = Math.max(v / 32767, -1);
      }
      out[i * numc + c] = v;
    }
  }
  return { data: out, numc, count: acc.count };
}

// --- node transforms (column-major 4x4, glTF convention) ------------------------------------------
function mat4Identity() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
function mat4Mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
function trsToMat4(node) {
  if (node.matrix) return node.matrix.slice();
  const t = node.translation || [0, 0, 0], q = node.rotation || [0, 0, 0, 1], s = node.scale || [1, 1, 1];
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
function applyMat4(m, p) {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}
function applyMat3(m, n) {
  const o = [m[0] * n[0] + m[4] * n[1] + m[8] * n[2], m[1] * n[0] + m[5] * n[1] + m[9] * n[2], m[2] * n[0] + m[6] * n[1] + m[10] * n[2]];
  const len = Math.hypot(o[0], o[1], o[2]) || 1;
  return [o[0] / len, o[1] / len, o[2] / len];
}

// --- images: PNG (8-bit RGB/RGBA via zlib), JPEG/TGA via the Quake 3 decoders --------------------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  let p = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("latin1", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; if (data[12] !== 0) throw new Error("interlaced PNG not supported"); }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error("PNG must be 8-bit RGB/RGBA (depth " + bitDepth + " colorType " + colorType + ")");
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rgb = Buffer.alloc(width * height * 3);
  const alpha = channels === 4 ? Buffer.alloc(width * height) : null;
  const line = Buffer.alloc(stride), prev = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    for (let i = 0; i < stride; i++) {
      const x = raw[rp++], a = i >= channels ? line[i - channels] : 0, b = prev[i], c = i >= channels ? prev[i - channels] : 0;
      let v;
      if (filter === 0) v = x; else if (filter === 1) v = x + a; else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      line[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) { const o = (y * width + x) * 3, s = x * channels; rgb[o] = line[s]; rgb[o + 1] = line[s + 1]; rgb[o + 2] = line[s + 2]; if (alpha) alpha[y * width + x] = line[s + 3]; }
    line.copy(prev);
  }
  return { width, height, rgb, alpha };
}
function decodeImage(name, buf) {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x89504e47) return decodePng(buf);
  const { decode } = require("../quake3/image");   // TGA + baseline JPEG
  return decode(name, buf);
}
function imageBytes(doc, gltf, buffers, image) {
  if (image.uri) { if (/^data:/.test(image.uri)) return decodeDataUri(image.uri); return fs.readFileSync(path.join(doc.dir, decodeURIComponent(image.uri))); }
  const bv = gltf.bufferViews[image.bufferView];
  const buf = buffers[bv.buffer];
  return buf.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
}

// --- the scene ------------------------------------------------------------------------------------
function loadScene(file, log) {
  const doc = loadDocument(file);
  const gltf = doc.gltf;
  const buffers = resolveBuffers(doc);
  const lightDefs = (gltf.extensions && gltf.extensions.KHR_lights_punctual && gltf.extensions.KHR_lights_punctual.lights) || [];

  const prims = [], lights = [];
  const roots = (gltf.scenes && gltf.scenes[gltf.scene || 0] && gltf.scenes[gltf.scene || 0].nodes) || (gltf.nodes ? gltf.nodes.map((_, i) => i) : []);
  const visit = (nodeIndex, parent, seen) => {
    if (seen.has(nodeIndex)) return;
    seen.add(nodeIndex);
    const node = gltf.nodes[nodeIndex];
    const world = mat4Mul(parent, trsToMat4(node));
    const lp = node.extensions && node.extensions.KHR_lights_punctual;
    if (lp && lightDefs[lp.light]) lights.push({ def: lightDefs[lp.light], pos: applyMat4(world, [0, 0, 0]), matrix: world });
    if (node.mesh !== undefined) {
      for (const prim of gltf.meshes[node.mesh].primitives) {
        if (prim.mode !== undefined && prim.mode !== 4) continue;
        if (prim.attributes.POSITION === undefined) continue;
        const pos = readAccessor(gltf, buffers, prim.attributes.POSITION);
        const nrm = prim.attributes.NORMAL !== undefined ? readAccessor(gltf, buffers, prim.attributes.NORMAL) : null;
        const uv = prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(gltf, buffers, prim.attributes.TEXCOORD_0) : null;
        const idx = prim.indices !== undefined ? readAccessor(gltf, buffers, prim.indices).data : Array.from({ length: pos.count }, (_, i) => i);
        prims.push({ pos, nrm, uv, indices: idx, material: prim.material, matrix: world });
      }
    }
    seen.delete(nodeIndex);
    for (const c of node.children || []) visit(c, world, seen);
  };
  for (const r of roots) visit(r, mat4Identity(), new Set());

  const materials = (gltf.materials || []).map((m) => {
    const pbr = m.pbrMetallicRoughness || {};
    let imageIndex = null;
    if (pbr.baseColorTexture) { const tex = gltf.textures[pbr.baseColorTexture.index]; if (tex && tex.source !== undefined) imageIndex = tex.source; }
    return { name: m.name, factor: pbr.baseColorFactor || [1, 1, 1, 1], imageIndex, alphaMode: m.alphaMode || "OPAQUE" };
  });
  const decodeMaterialImage = (imageIndex) => {
    const img = gltf.images[imageIndex];
    return decodeImage(img.name || img.uri || ("image" + imageIndex), imageBytes(doc, gltf, buffers, img));
  };

  if (log) log("glTF: " + prims.length + " primitive(s), " + materials.length + " material(s), " + (gltf.images ? gltf.images.length : 0) + " image(s), " + lights.length + " light(s)");
  return { prims, materials, lights, decodeMaterialImage, applyMat4, applyMat3 };
}

module.exports = { loadScene, loadDocument, decodePng, decodeImage };
