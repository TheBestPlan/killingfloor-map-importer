// The heightfield, cut into static meshes Killing Floor can hold.
//
// KFEd crashes importing a mesh over 20000 polygons and the index stream is 16-bit either way, so a
// 255x255 grid - 130050 quads - cannot be one object. It goes out as square patches; each patch is
// authored around its own centre and its actor carries that centre, which is the same shape the
// GoldSrc route uses for its chunks.
//
// Inside a patch the quads are grouped by which terrain layer paints them (see layers.js), one
// section per layer, because a section is what carries a material. Vertices are shared inside a
// group but not across groups: two layers can want different tiling of the same corner, and a
// vertex has one UV.
"use strict";

// Quads per patch side. 32 gives at most 2048 triangles per mesh, so a full square is 64 meshes -
// well inside both the polygon limit and the 65535-vertex index range even when every quad is a
// different layer.
const PATCH = 32;

function patchMesh(terrain, x0, y0, w, h, step, opts) {
  const { layerAt, materialOf } = opts;
  const at = (ix, iy) => terrain.vertex(Math.min(terrain.width - 1, ix), Math.min(terrain.height - 1, iy));

  const c0 = at(x0, y0), c1 = at(x0 + w * step, y0 + h * step);
  const origin = [(c0[0] + c1[0]) / 2, (c0[1] + c1[1]) / 2, 0];

  // Grid vertex -> per-group index, so quads of one layer share their corners.
  const groups = new Map();
  const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };

  const vertexOf = (g, ix, iy) => {
    const key = iy * (terrain.width + 1) + ix;
    const known = g.index.get(key);
    if (known !== undefined) return known;
    const p = at(ix, iy);
    // Central differences on the heightfield: the cross product of the two slopes is the normal, and
    // taking it from the grid rather than from the triangles keeps the shading smooth across seams.
    const l = at(Math.max(0, ix - step), iy), r = at(Math.min(terrain.width - 1, ix + step), iy);
    const d = at(ix, Math.max(0, iy - step)), u = at(ix, Math.min(terrain.height - 1, iy + step));
    const nx = (l[2] - r[2]) * (u[1] - d[1]);
    const ny = (d[2] - u[2]) * (r[0] - l[0]);
    const nz = (r[0] - l[0]) * (u[1] - d[1]);
    const len = Math.hypot(nx, ny, nz) || 1;
    const pos = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
    for (let k = 0; k < 3; k++) {
      if (pos[k] < bbox.min[k]) bbox.min[k] = pos[k];
      if (pos[k] > bbox.max[k]) bbox.max[k] = pos[k];
    }
    const idx = g.vertices.length;
    g.vertices.push({ pos, normal: [nx / len, ny / len, nz / len] });
    g.uvs.push([ix * g.uv[0], iy * g.uv[1]]);
    g.index.set(key, idx);
    return idx;
  };

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const ix = x0 + i * step, iy = y0 + j * step;
      // A cleared visibility bit is a hole in the ground - a cave mouth, the inside of a basin.
      if (!terrain.quadVisible(ix, iy)) continue;
      const layer = layerAt(ix, iy);
      const mat = materialOf(layer);
      if (!mat) continue;
      let g = groups.get(layer);
      if (!g) {
        g = { layer, mat, uv: [mat.uScale, mat.vScale], vertices: [], uvs: [], indices: [], index: new Map() };
        groups.set(layer, g);
      }
      const a = vertexOf(g, ix, iy), b = vertexOf(g, ix + step, iy);
      const c = vertexOf(g, ix, iy + step), dd = vertexOf(g, ix + step, iy + step);
      // Wound so the face points up: Unreal draws front faces clockwise in a left-handed space, and
      // the terrain is read row by row in +X/+Y.
      g.indices.push(a, c, b, b, c, dd);
    }
  }
  if (!groups.size) return null;

  // Concatenate the groups: one section each, in the order they are laid down.
  const vertices = [], uvs = [], colors = [], indices = [], sections = [], materials = [];
  for (const g of groups.values()) {
    if (!g.indices.length) continue;
    const vBase = vertices.length, iBase = indices.length;
    for (const v of g.vertices) vertices.push(v);
    for (const t of g.uvs) uvs.push(t);
    for (const i of g.indices) indices.push(vBase + i);
    for (let k = 0; k < g.vertices.length; k++) colors.push([255, 255, 255, 255]);
    sections.push({
      firstIndex: iBase, firstVertex: vBase,
      lastVertex: vertices.length - 1, numFaces: g.indices.length / 3,
    });
    materials.push(g.mat.texRef);
  }
  if (!indices.length) return null;

  const radius = Math.hypot(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]) / 2;
  return {
    materials, vertices, uvs, colors, indices, sections, bbox,
    center: [(bbox.min[0] + bbox.max[0]) / 2, (bbox.min[1] + bbox.max[1]) / 2, (bbox.min[2] + bbox.max[2]) / 2],
    radius, origin,
  };
}

// The whole square. `step` thins the grid: 1 keeps every terrain vertex, 2 takes every other one.
function buildTerrainMeshes(terrain, opts) {
  const step = Math.max(1, Math.round((opts && opts.step) || 1));
  const patch = Math.max(4, Math.round((opts && opts.patch) || PATCH));
  const layerAt = (opts && opts.layerAt) || (() => 0);
  const materialOf = opts.materialOf;
  const meshes = [];
  const quads = terrain.width - 1;
  let triangles = 0, holes = 0, sections = 0;
  for (let y0 = 0; y0 < quads; y0 += patch * step) {
    for (let x0 = 0; x0 < quads; x0 += patch * step) {
      const w = Math.min(patch, Math.ceil((quads - x0) / step));
      const h = Math.min(patch, Math.ceil((quads - y0) / step));
      if (w <= 0 || h <= 0) continue;
      const m = patchMesh(terrain, x0, y0, w, h, step, { layerAt, materialOf });
      if (!m) { holes++; continue; }
      triangles += m.indices.length / 3;
      sections += m.sections.length;
      meshes.push(m);
    }
  }
  return { meshes, triangles, holes, sections, step };
}

module.exports = { buildTerrainMeshes, PATCH };
