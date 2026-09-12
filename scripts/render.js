// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Rasterise a converted .rom offline, so "the client draws shards" can be told apart from "the
// geometry IS shards". Flat grey shading, no textures - the question it answers is which surfaces
// are there and which way they face.
//
//   node scripts/render.js <map.rom> <x,y,z> <yaw 0..65535> [out.bmp] [pitch]
//   CULL=back|front   cull one side, to compare against the client's frame (GOTCHAS 5.40)
//   NO_SKY=1          leave the sky room out
//   PROBE="x,y;x,y"   print which mesh owns a pixel, and at what depth
//
// The BMP is the same 24-bit, padded-row file harness/bmp2png.js reads.
"use strict";
const fs = require("fs");
const path = require("path");
const { parsePackage } = require("../src/unreal/read");
const { readMesh } = require("../src/unreal/staticmesh");
const { tagsOf, pick, val } = require("../src/lineage2/props");

if (process.argv.length < 5) {
  console.log("usage: node scripts/render.js <map.rom> <x,y,z> <yaw 0..65535> [out.bmp] [pitch]");
  process.exit(1);
}
const file = process.argv[2];
const eye = process.argv[3].split(",").map(Number);
const yaw = (Number(process.argv[4] || 0) / 65536) * Math.PI * 2;
const out = process.argv[5] || "render.bmp";
const pitch = (Number(process.argv[6] || 0) / 65536) * Math.PI * 2;

const W = 700, H = 425, FOV = 90 * Math.PI / 180;
const pkg = parsePackage(fs.readFileSync(file));

// Every StaticMeshActor and the mesh it carries, in world space.
const meshByRef = new Map();
pkg.exports.forEach((e, i) => { if (pkg.classOf(e) === "StaticMesh") meshByRef.set(i + 1, e); });
const tris = [];
let actors = 0, skipped = 0;
for (const e of pkg.exports) {
  const cls = pkg.classOf(e);
  if (cls !== "StaticMeshActor" && cls !== "KFDoorMover") continue;
  let tags;
  try { tags = tagsOf(pkg, e).tags; } catch (err) { continue; }
  const smTag = pick(tags, "StaticMesh");
  const locTag = pick(tags, "Location");
  if (!smTag || !locTag) continue;
  const exp = meshByRef.get(val.ref(pkg, smTag));
  if (!exp) continue;
  if (process.env.NO_SKY && /_sky\d+$/.test(exp.name)) { skipped++; continue; }
  const loc = val.vector(pkg, locTag);
  const m = readMesh(pkg, exp);
  actors++;
  for (let i = 0; i + 2 < m.indices.length; i += 3) {
    const p = [m.indices[i], m.indices[i + 1], m.indices[i + 2]].map((k) => {
      const v = m.vertices[k].pos;
      return [v[0] + loc[0], v[1] + loc[1], v[2] + loc[2]];
    });
    tris.push(Object.assign(p, { mesh: exp.name }));
  }
}

// World -> camera. Unreal: X forward at yaw 0, Y right, Z up.
const cy = Math.cos(-yaw), sy = Math.sin(-yaw);
const cp = Math.cos(-pitch), sp = Math.sin(-pitch);
const toCam = (p) => {
  const x = p[0] - eye[0], y = p[1] - eye[1], z = p[2] - eye[2];
  const fx = x * cy - y * sy, fy = x * sy + y * cy;          // yaw
  return [fx * cp - z * sp, fy, fx * sp + z * cp];           // pitch: [forward, right, up]
};
const f = (W / 2) / Math.tan(FOV / 2);

const depth = new Float64Array(W * H).fill(Infinity);
const owner = new Array(W * H).fill(null);
const depthOwner = new Float64Array(W * H).fill(0);
const rgb = Buffer.alloc(W * H * 3);
const shade = (n) => {
  const l = Math.abs(n[0] * 0.4 + n[1] * 0.5 + n[2] * 0.75);
  return Math.max(30, Math.min(255, Math.round(60 + 195 * l)));
};

let drawn = 0, behind = 0, culled = 0;
for (const t of tris) {
  const c = t.map(toCam);
  if (c.every((p) => p[0] < 1)) { behind++; continue; }
  if (c.some((p) => p[0] < 1)) continue;                     // no near-plane clipping: skip
  const s = c.map((p) => [W / 2 + (p[1] * f) / p[0], H / 2 - (p[2] * f) / p[0], p[0]]);
  const e1 = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
  const e2 = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
  const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
  const len = Math.hypot(nx, ny, nz) || 1;
  const grey = shade([nx / len, ny / len, nz / len]);
  if (process.env.CULL) {
    const mid = [(t[0][0] + t[1][0] + t[2][0]) / 3 - eye[0], (t[0][1] + t[1][1] + t[2][1]) / 3 - eye[1],
      (t[0][2] + t[1][2] + t[2][2]) / 3 - eye[2]];
    const facing = nx * mid[0] + ny * mid[1] + nz * mid[2];
    if (process.env.CULL === "back" ? facing > 0 : facing < 0) { culled++; continue; }
  }
  const minX = Math.max(0, Math.floor(Math.min(s[0][0], s[1][0], s[2][0])));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(s[0][0], s[1][0], s[2][0])));
  const minY = Math.max(0, Math.floor(Math.min(s[0][1], s[1][1], s[2][1])));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(s[0][1], s[1][1], s[2][1])));
  const area = (s[1][0] - s[0][0]) * (s[2][1] - s[0][1]) - (s[2][0] - s[0][0]) * (s[1][1] - s[0][1]);
  if (Math.abs(area) < 1e-9) continue;
  drawn++;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const w0 = ((s[1][0] - s[0][0]) * (y + 0.5 - s[0][1]) - (x + 0.5 - s[0][0]) * (s[1][1] - s[0][1])) / area;
      const w1 = ((x + 0.5 - s[0][0]) * (s[2][1] - s[0][1]) - (s[2][0] - s[0][0]) * (y + 0.5 - s[0][1])) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w2 * s[0][2] + w1 * s[1][2] + w0 * s[2][2];
      const at = y * W + x;
      if (z >= depth[at]) continue;
      depth[at] = z;
      rgb[at * 3] = grey; rgb[at * 3 + 1] = grey; rgb[at * 3 + 2] = grey;
      owner[at] = t.mesh; depthOwner[at] = z;
    }
  }
}

// 24-bit BMP, bottom-up, padded rows - harness/bmp2png.js reads it.
const stride = W * 3 + ((4 - (W * 3) % 4) % 4);
const buf = Buffer.alloc(54 + stride * H);
buf.write("BM", 0);
buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10);
buf.writeUInt32LE(40, 14); buf.writeInt32LE(W, 18); buf.writeInt32LE(H, 22);
buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28); buf.writeUInt32LE(stride * H, 34);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const s = ((H - 1 - y) * W + x) * 3, d = 54 + y * stride + x * 3;
    buf[d] = rgb[s + 2]; buf[d + 1] = rgb[s + 1]; buf[d + 2] = rgb[s];
  }
}
fs.writeFileSync(out, buf);
if (process.env.PROBE) {
  for (const spec of process.env.PROBE.split(";")) {
    const [px, py] = spec.split(",").map(Number);
    console.log("pixel " + px + "," + py + " -> " + (owner[py * W + px] || "nothing") +
      " at depth " + Math.round(depthOwner[py * W + px]));
  }
}
if (process.env.OWNERS) {
  // Which meshes the frame is actually made of, and how near each one is: "the door is drawn" and
  // "the door's far side is drawn" differ by nothing but that depth.
  const re = new RegExp(process.env.OWNERS === "1" ? "." : process.env.OWNERS, "i");
  const seen = new Map();
  for (let i = 0; i < owner.length; i++) {
    if (!owner[i] || !re.test(owner[i])) continue;
    const s = seen.get(owner[i]) || { px: 0, near: Infinity };
    s.px++; s.near = Math.min(s.near, depthOwner[i]);
    seen.set(owner[i], s);
  }
  [...seen].sort((a, b) => b[1].px - a[1].px).slice(0, 20)
    .forEach(([k, s]) => console.log("  " + k + ": " + s.px + " px, nearest " + Math.round(s.near)));
}
console.log(path.basename(file) + ": " + actors + " mesh actors" + (skipped ? " (" + skipped + " sky skipped)" : "") +
  ", " + tris.length + " triangles, " + drawn + " rasterised, " + culled + " culled, " +
  behind + " behind the camera -> " + out);
