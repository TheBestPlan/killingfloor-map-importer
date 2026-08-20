// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// glTF scene primitives -> UE2.5 static meshes.
//
// Output is the shape unreal/staticmesh.js serializes unchanged, the same one build/mesh.js and
// quake3/mesh.js produce:
//   [{ materials, vertices, uvs, colors, indices, sections, bbox, center, radius, origin }]
//
// The scene is already placed (each primitive carries its node's world matrix), so vertices go to
// world space here; a spatial grid chunks it for culling and an optional crop keeps one square.
"use strict";

// Three points on one line make a zero-area triangle: it draws nothing but feeds Karma a NaN contact
// normal that throws ragdolls out of the level. Same guard the BSP routes carry (build/mesh.js).
const collinear = (a, b, c) => {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  return nx * nx + ny * ny + nz * nz <= 1e-6;
};

const MAX_TRIS = 19000;                          // KFEd crashes importing a static mesh over ~20000
const MAX_VERTS = 60000;                         // the index stream is 16-bit
const CELL = +(process.env.KF_CELL || 2048);     // spatial chunk size in Unreal units; 0 = off

// glTF is right-handed, +Y up; KF (Unreal) is left-handed, +Z up. (x,y,z) -> (x, z, y) lands glTF's
// up on Unreal's Z and reflects one axis (right-handed -> left-handed), so the winding is reversed to
// match, exactly as the Y-mirror does on the other routes. A Z-up source (Source BSP) instead wants
// (x, -y, z) - axes [0,1,2] with flip Y - the same reflection GoldSrc uses. KF_GLTF_AXES /
// KF_GLTF_FLIP override the glTF default; the source route passes opts.axes/opts.flip.
const AXES = (process.env.KF_GLTF_AXES || "0,2,1").split(",").map(Number);
const FLIP = (process.env.KF_GLTF_FLIP || "0,0,0").split(",").map(Number);
function toKFa(p, S, axes, flip) {
  return [(flip[0] ? -p[axes[0]] : p[axes[0]]) * S, (flip[1] ? -p[axes[1]] : p[axes[1]]) * S, (flip[2] ? -p[axes[2]] : p[axes[2]]) * S];
}
function normKFa(n, axes, flip) {
  const o = [flip[0] ? -n[axes[0]] : n[axes[0]], flip[1] ? -n[axes[1]] : n[axes[1]], flip[2] ? -n[axes[2]] : n[axes[2]]];
  const len = Math.hypot(o[0], o[1], o[2]) || 1;
  return [o[0] / len, o[1] / len, o[2] / len];
}
function toKF(p, S) { return toKFa(p, S, AXES, FLIP); }   // env default, for the glTF light code
const REVERSE_WINDING = true;

// opts: { scale, applyMat4, applyMat3, crop, matKind, axes?, flip? }
function buildMeshes(scene, opts) {
  const S = opts.scale;
  const crop = opts.crop || null;
  const matKind = opts.matKind || (() => null);
  const axes = opts.axes || AXES;
  const flip = opts.flip || FLIP;
  const toKF = (p, s) => toKFa(p, s, axes, flip);
  const normKF = (n) => normKFa(n, axes, flip);

  const stats = { prims: 0, faces: 0, triangles: 0, skipped: 0, flat3: 0, cropped: 0 };
  const surfaces = [];
  for (const prim of scene.prims) {
    stats.prims++;
    const M = prim.matrix, P = prim.pos.data, N = prim.nrm ? prim.nrm.data : null, U = prim.uv ? prim.uv.data : null;
    const nv = prim.pos.count;
    const verts = new Array(nv);
    for (let i = 0; i < nv; i++) {
      const world = scene.applyMat4(M, [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
      const pos = toKF(world, S);
      let normal = [0, 0, 1];
      if (N) normal = normKF(scene.applyMat3(M, [N[i * 3], N[i * 3 + 1], N[i * 3 + 2]]));
      verts[i] = { pos, normal, uv: U ? [U[i * 2], U[i * 2 + 1]] : [0, 0] };
    }
    const idx = prim.indices;
    for (let i = 0; i + 2 < idx.length; i += 3) {
      stats.faces++;
      let a = idx[i], b = idx[i + 1], c = idx[i + 2];
      if (REVERSE_WINDING) { const t = b; b = c; c = t; }
      const va = verts[a], vb = verts[b], vc = verts[c];
      if (!va || !vb || !vc) { stats.skipped++; continue; }
      if (collinear(va.pos, vb.pos, vc.pos)) { stats.flat3++; continue; }
      const mid = [(va.pos[0] + vb.pos[0] + vc.pos[0]) / 3, (va.pos[1] + vb.pos[1] + vc.pos[1]) / 3, (va.pos[2] + vb.pos[2] + vc.pos[2]) / 3];
      if (crop && (Math.abs(mid[0] - crop.cx) > crop.half || Math.abs(mid[1] - crop.cy) > crop.half)) { stats.cropped++; continue; }
      surfaces.push({ verts: [va, vb, vc], mat: prim.material === undefined ? -1 : prim.material, mid });
      stats.triangles++;
    }
  }

  const cellOf = (s) => (CELL ? Math.floor(s.mid[0] / CELL) + "," + Math.floor(s.mid[1] / CELL) : "all");
  const byGroup = new Map();
  for (const s of surfaces) {
    const key = cellOf(s) + "|" + s.mat;
    let list = byGroup.get(key);
    if (!list) { list = { mat: s.mat, tris: [] }; byGroup.set(key, list); }
    list.tris.push(s);
  }

  const meshes = [];
  for (const group of byGroup.values()) {
    let cur = null;
    const start = () => { cur = { mat: group.mat, vertices: [], uvs: [], colors: [], indices: [], sections: [], kind: matKind(group.mat) }; meshes.push(cur); };
    for (const tri of group.tris) {
      if (!cur || cur.vertices.length + 3 > MAX_VERTS || cur.indices.length / 3 + 1 > MAX_TRIS) start();
      const base = cur.vertices.length;
      for (const v of tri.verts) {
        cur.vertices.push({ pos: v.pos.slice(), normal: v.normal });
        cur.uvs.push(v.uv);
        cur.colors.push([0, 0, 0, 255]);   // neutral: lit by zone ambient + actor glow + lights
      }
      cur.indices.push(base, base + 1, base + 2);
    }
  }

  for (const m of meshes) {
    if (!m.vertices.length) continue;
    m.sections.push({ f0: 0, firstIndex: 0, firstVertex: 0, lastVertex: m.vertices.length - 1, u4: 0, numFaces: m.indices.length / 3 });
  }
  // Re-centre every mesh on its own bbox (a static mesh is authored in LOCAL space; see quake3/mesh.js).
  for (const m of meshes) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const v of m.vertices) for (let k = 0; k < 3; k++) { if (v.pos[k] < lo[k]) lo[k] = v.pos[k]; if (v.pos[k] > hi[k]) hi[k] = v.pos[k]; }
    if (!m.vertices.length) { m.bbox = { min: [0, 0, 0], max: [0, 0, 0] }; m.center = [0, 0, 0]; m.radius = 0; m.origin = [0, 0, 0]; continue; }
    const origin = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
    for (const v of m.vertices) v.pos = [0, 1, 2].map((k) => v.pos[k] - origin[k]);
    m.origin = origin;
    m.bbox = { min: [0, 1, 2].map((k) => lo[k] - origin[k]), max: [0, 1, 2].map((k) => hi[k] - origin[k]) };
    m.center = [0, 0, 0];
    m.radius = Math.hypot(m.bbox.max[0], m.bbox.max[1], m.bbox.max[2]);
  }
  return { meshes: meshes.filter((m) => m.vertices.length >= 3 && m.indices.length >= 3), stats };
}

module.exports = { buildMeshes, MAX_TRIS, toKF };
