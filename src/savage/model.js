// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// S2 Silverback (Savage) .model reader. Magic "SMDL" then chunks [4b name][4b LE size][data]:
//   head - version, mesh count, bbox
//   bone - skeleton (skipped)
//   per mesh: mesh (u32 index + mesh name + the .tga texture name), vrts (u32 + float3 verts),
//             texc (u32 + float2 UVs), face (u32 + u32 triCount + triCount*3 u32 indices), nrml, colr, surf
// Returns { meshes: [{ verts:Float32Array, uvs, indices:Uint32Array, texture }] } in model space.
"use strict";

function readModel(buf) {
  if (buf.length < 4 || buf.toString("latin1", 0, 4) !== "SMDL") throw new Error("not an SMDL model");
  const meshes = [];
  let cur = null, p = 4;
  while (p + 8 <= buf.length) {
    const name = buf.toString("latin1", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (!/^[A-Za-z]{3,4}$/.test(name) || p + 8 + size > buf.length) break;
    const off = p + 8;
    if (name === "mesh") {
      const ascii = buf.toString("latin1", off, off + size);
      const tex = ascii.match(/([\w./\\-]+\.tga)/i);
      cur = { verts: null, uvs: null, indices: null, texture: tex ? tex[1].toLowerCase().replace(/\\/g, "/") : null };
      meshes.push(cur);
    } else if (name === "vrts" && cur) {
      const n = ((size - 4) / 12) | 0; const v = new Float32Array(n * 3);
      for (let i = 0; i < n * 3; i++) v[i] = buf.readFloatLE(off + 4 + i * 4);
      cur.verts = v;
    } else if (name === "texc" && cur) {
      const n = ((size - 4) / 8) | 0; const u = new Float32Array(n * 2);
      for (let i = 0; i < n * 2; i++) u[i] = buf.readFloatLE(off + 4 + i * 4);
      cur.uvs = u;
    } else if (name === "face" && cur) {
      const tri = buf.readUInt32LE(off + 4); const idx = new Uint32Array(tri * 3);
      for (let i = 0; i < tri * 3; i++) idx[i] = buf.readUInt32LE(off + 8 + i * 4);
      cur.indices = idx;
    }
    p = off + size;
  }
  return { meshes: meshes.filter((m) => m.verts && m.indices && m.indices.length) };
}

module.exports = { readModel };

// Self-check: round-trip a tiny hand-built SMDL (head + one mesh: 1 tri, 3 verts) and verify the parse.
if (require.main === module) {
  const chunks = [];
  const chunk = (name, body) => { const h = Buffer.alloc(8); h.write(name, 0, "latin1"); h.writeUInt32LE(body.length, 4); chunks.push(h, body); };
  const head = Buffer.alloc(44); head.writeUInt32LE(1, 4); chunk("head", head);
  const mesh = Buffer.from("\0\0\0\0Line01\0\0t_test.tga\0", "latin1"); chunk("mesh", mesh);
  const vrts = Buffer.alloc(4 + 3 * 12); [0, 0, 0, 100, 0, 0, 0, 100, 0].forEach((v, i) => vrts.writeFloatLE(v, 4 + i * 4)); chunk("vrts", vrts);
  const texc = Buffer.alloc(4 + 3 * 8); [0, 0, 1, 0, 0, 1].forEach((v, i) => texc.writeFloatLE(v, 4 + i * 4)); chunk("texc", texc);
  const face = Buffer.alloc(8 + 3 * 4); face.writeUInt32LE(1, 4);[0, 1, 2].forEach((v, i) => face.writeUInt32LE(v, 8 + i * 4)); chunk("face", face);
  const buf = Buffer.concat([Buffer.from("SMDL", "latin1"), ...chunks]);
  const m = readModel(buf);
  const assert = (c, msg) => { if (!c) throw new Error("model self-check: " + msg); };
  assert(m.meshes.length === 1, "mesh count " + m.meshes.length);
  assert(m.meshes[0].verts.length === 9, "verts " + m.meshes[0].verts.length);
  assert(m.meshes[0].indices.length === 3, "indices " + m.meshes[0].indices.length);
  assert(m.meshes[0].texture === "t_test.tga", "texture " + m.meshes[0].texture);
  assert(m.meshes[0].verts[3] === 100, "vert1.x " + m.meshes[0].verts[3]);
  console.log("model.js: SMDL parse OK (1 mesh, 3 verts, 1 tri, tex t_test.tga)");
}
