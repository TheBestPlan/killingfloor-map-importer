// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// A loaded .mdl turned into the same mesh shape build/mesh.js produces, so it can go through
// unreal/staticmesh.js unchanged.
//
// GoldSrc models carry no lighting of their own - the engine lights them per-vertex from the
// lightmap under the entity. There is nothing to sample here, so every vertex gets one flat colour;
// the caller passes the level's own ambient so a prop is not brighter than the wall behind it.
"use strict";

function buildPropMesh(mdl, opts) {
  const S = opts.scale;
  const light = opts.light || [140, 140, 140];
  const materials = [], vertices = [], uvs = [], colors = [], indices = [], sections = [];

  for (const part of mdl.parts) {
    const texRef = opts.texRefOf(part.tex);
    if (!texRef) continue;
    const firstIndex = indices.length, firstVertex = vertices.length;
    for (const tri of part.tris) {
      // Same Y mirror and same winding reversal as the world geometry: mirroring flips the
      // orientation the rasteriser sees, so the ring has to be re-ordered or the model is inside out.
      const t = [tri[0], tri[2], tri[1]];
      const p = t.map((v) => [v.pos[0] * S, -v.pos[1] * S, v.pos[2] * S]);
      const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
      const e2 = [p[2][0] - p[1][0], p[2][1] - p[1][1], p[2][2] - p[1][2]];
      let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      n = [n[0] / len, n[1] / len, n[2] / len];
      for (let k = 0; k < 3; k++) {
        indices.push(vertices.length);
        vertices.push({ pos: p[k], normal: n });
        uvs.push(t[k].uv);
        colors.push([light[2], light[1], light[0], 255]);      // FColor is BGRA on disk
      }
    }
    materials.push(texRef);
    sections.push({
      f0: 0, firstIndex, firstVertex,
      lastVertex: Math.max(firstVertex, vertices.length - 1),
      u4: 0, numFaces: part.tris.length,
    });
  }
  if (!vertices.length) return null;

  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const v of vertices) for (let c = 0; c < 3; c++) {
    if (v.pos[c] < lo[c]) lo[c] = v.pos[c];
    if (v.pos[c] > hi[c]) hi[c] = v.pos[c];
  }
  const bbox = { min: lo, max: hi };
  const center = [0, 1, 2].map((c) => (lo[c] + hi[c]) / 2);
  return {
    materials, vertices, uvs, colors, indices, sections, bbox, center,
    radius: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2,
    origin: [0, 0, 0],
  };
}

module.exports = { buildPropMesh };
