// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Project IGI .mef mesh (ILFF form OCEM). What the map route needs:
//   HSEM (MESH header, 156B): model type @32, render face count @96, render vertex count @100.
//   XTRV (VRTX): render vertices, stride = size / vertexCount, position float3 at offset 0 (already
//                in world space - IGI bakes each object's placement into its vertices).
//   DNER (REND): render groups, index buffer stored INLINE per group. Each group is a header followed by
//                `indexCount` little-endian u16 triangle-list indices, local to the group's vertexStart.
//                The header size and the vertexStart offset depend on HSEM's model type (verified by
//                brute force against every mesh in level2.res: the per-group index counts must sum to
//                renderFaceCount*3 and the walk must consume the whole DNER chunk exactly):
//                  type 3  -> 32-byte header, indexCount u16 @12, vertexStart u16 @20 (203/205 exact)
//                  type 0/1 -> 28-byte header, indexCount u16 @12, vertexStart u16 @18, count u16 @20
//                A single decode of all types matches; the old fixed 32-byte header misaligned every
//                type-0/1 group after the first, which is what produced the map-spanning garbage.
"use strict";

const { readIlff } = require("./ilff");

// DNER group header layout by HSEM model type: [headerBytes, vertexStart u16 offset].
const dnerLayout = (type) => (type === 3 ? [32, 20] : [28, 18]);

// Parse one .mef (buf, at offset base) -> { verts: Float32Array(world xyz), tris: [[i0,i1,i2]] } or null.
function readMef(buf, base) {
  let ilff;
  try { ilff = readIlff(buf, base); } catch (e) { return null; }
  if (ilff.form !== "OCEM") return null;                 // not a standard render mesh (e.g. SEMS collision-only)
  const get = (n) => ilff.chunks.find((c) => c.name === n);
  const hsem = get("HSEM"), xtrv = get("XTRV"), dner = get("DNER");
  if (!hsem || !xtrv || !dner) return null;

  const vertCount = buf.readUInt32LE(hsem.data + 100);
  const faceCount = buf.readUInt32LE(hsem.data + 96);
  if (!vertCount || !faceCount) return null;
  const stride = Math.floor(xtrv.size / vertCount);
  if (stride < 12) return null;
  const [DNER_HEADER, VSTART_OFF] = dnerLayout(buf.readUInt32LE(hsem.data + 32));

  // Vertex: pos float3 @0, normal float3 @12, UV float2 @24 (type-3 stride 40 adds lightmap UV @32;
  // type-0/1 stride 32). UV present when the record reaches 32 bytes. Layout from igipy/K2 (igix 10f).
  const verts = new Float32Array(vertCount * 3);
  const hasUv = stride >= 32;
  const uvs = hasUv ? new Float32Array(vertCount * 2) : null;
  for (let i = 0; i < vertCount; i++) {
    const o = xtrv.data + i * stride;
    verts[i * 3] = buf.readFloatLE(o); verts[i * 3 + 1] = buf.readFloatLE(o + 4); verts[i * 3 + 2] = buf.readFloatLE(o + 8);
    if (hasUv) { uvs[i * 2] = buf.readFloatLE(o + 24); uvs[i * 2 + 1] = buf.readFloatLE(o + 28); }
  }

  // Each DNER group carries its MATERIAL index at u16 @16 (verified: model 709_01_2 groups index
  // 0..10 with one reused), which selects a texture from the model's list in the level .mtp (INST chunk).
  // Keep the groups separate so the map route can texture each with its own .tex.
  const groups = [];
  const end = dner.data + dner.size;
  let p = dner.data;
  while (p + DNER_HEADER <= end) {
    const indexCount = buf.readUInt16LE(p + 12);
    const vertexStart = buf.readUInt16LE(p + VSTART_OFF);
    const mat = buf.readUInt16LE(p + 16);
    const ip = p + DNER_HEADER;
    if (indexCount === 0 || ip + indexCount * 2 > end) break;
    const gtris = [];
    for (let i = 0; i + 2 < indexCount; i += 3) {
      const a = vertexStart + buf.readUInt16LE(ip + i * 2);
      const b = vertexStart + buf.readUInt16LE(ip + (i + 1) * 2);
      const c = vertexStart + buf.readUInt16LE(ip + (i + 2) * 2);
      if (a < vertCount && b < vertCount && c < vertCount) gtris.push([a, b, c]);
    }
    if (gtris.length) groups.push({ mat, tris: gtris });
    p = ip + indexCount * 2;
  }
  const allTris = groups.reduce((s, g) => s.concat(g.tris), []);
  if (!allTris.length) return null;

  // With the header decoded per type the groups align, but guard against a stray mis-sized group: drop
  // any triangle whose edge is a gross outlier (absolute cap and many times the model's median edge).
  const edge = (t) => { const a = t[0] * 3, b = t[1] * 3, c = t[2] * 3; return Math.max(dist3(verts, a, b), dist3(verts, b, c), dist3(verts, a, c)); };
  const edges = allTris.map(edge).filter((e) => e > 0).sort((x, y) => x - y);
  const cap = Math.max(2500, (edges.length ? edges[edges.length >> 1] : 1) * 12);
  for (const g of groups) g.tris = g.tris.filter((t) => edge(t) <= cap);
  const kept = groups.filter((g) => g.tris.length);
  if (!kept.length) return null;
  return { verts, uvs, groups: kept, tris: kept.reduce((s, g) => s.concat(g.tris), []) };
}

function dist3(v, a, b) {
  const dx = v[a] - v[b], dy = v[a + 1] - v[b + 1], dz = v[a + 2] - v[b + 2];
  return Math.hypot(dx, dy, dz);
}

module.exports = { readMef };
