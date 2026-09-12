// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Coverage-preserving mesh decimation by uniform vertex clustering. A baked CS2 world is ~4.5M triangles
// - far past what KF renders smoothly - and dropping whole meshes to fit a budget leaves holes in walls.
// Clustering instead snaps every vertex onto a shared world grid and collapses the vertices that land in
// one cell to a single representative (the cell's average position, so it is gap-free: two meshes that
// meet at a cell snap to the same point). Triangles that go degenerate are dropped. The surface stays put
// (coverage preserved - no new holes), only its detail coarsens. One global grid is used for every prim so
// nothing tears at mesh seams; each prim keeps its own material and UVs.
"use strict";

function bounds(prims) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of prims) {
    const d = p.pos.data;
    for (let i = 0; i < d.length; i += 3) for (let k = 0; k < 3; k++) { if (d[i + k] < lo[k]) lo[k] = d[i + k]; if (d[i + k] > hi[k]) hi[k] = d[i + k]; }
  }
  return { lo, hi };
}

const cellKey = (x, y, z, cell, o) => (Math.floor((x - o[0]) / cell)) + "," + (Math.floor((y - o[1]) / cell)) + "," + (Math.floor((z - o[2]) / cell));

// Collapse one prim onto the grid; `rep` maps cellKey -> averaged world position shared across all prims.
function collapsePrim(prim, cell, o, rep) {
  const d = prim.pos.data, uv = prim.uv && prim.uv.data, nrm = prim.nrm && prim.nrm.data, idx = prim.indices;
  const local = new Map();                 // cellKey -> new vertex index within this prim
  const npos = [], nuv = uv ? [] : null, nnrm = nrm ? [] : null;
  const remap = new Int32Array(prim.pos.count);
  for (let v = 0; v < prim.pos.count; v++) {
    const ck = cellKey(d[v * 3], d[v * 3 + 1], d[v * 3 + 2], cell, o);
    // Split a cell by UV too: merging vertices that share a 3D cell but sit far apart in UV space snaps
    // the texture and reads as "stretched/corrupted" on walls. Keeping them separate (a UV seam) costs a
    // few vertices but keeps the texture aligned. The rep POSITION is still per-3D-cell so seams stay gap-free.
    const key = uv ? ck + "|" + Math.round(uv[v * 2] * 4) + "," + Math.round(uv[v * 2 + 1] * 4) : ck;
    let ni = local.get(key);
    if (ni === undefined) {
      ni = npos.length / 3; local.set(key, ni);
      const r = rep.get(ck);               // averaged position per 3D cell (gap-free across prims)
      npos.push(r[0], r[1], r[2]);
      if (nuv) nuv.push(uv[v * 2], uv[v * 2 + 1]);
      if (nnrm) nnrm.push(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]);
    }
    remap[v] = ni;
  }
  const nidx = [];
  const P = npos;
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = remap[idx[i]], b = remap[idx[i + 1]], c = remap[idx[i + 2]];
    if (a === b || b === c || a === c) continue;     // index-collapsed to a line/point - drop
    // Drop on GEOMETRY, not just index equality. UV-splitting (above) can hand a triangle three DISTINCT
    // indices whose POSITIONS all coincide - every vertex landed in one cell - which the index test misses.
    // That is a zero-area triangle: it draws nothing but survives into the mesh builder, which culls it as
    // collinear (and a whole coarse tile so culled holes out to almost nothing). A null longest edge means
    // the three positions coincide; a sliver is a triangle whose height is a fraction of its base. Both go.
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
    const cx = P[c * 3], cy = P[c * 3 + 1], cz = P[c * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const area2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    const longest = Math.sqrt(Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, (bx - cx) ** 2 + (by - cy) ** 2 + (bz - cz) ** 2));
    if (!(longest > 0) || area2 / longest < longest * 0.02) continue;   // coincident / thin sliver - drop
    nidx.push(a, b, c);
  }
  if (!nidx.length) return null;
  return {
    matrix: prim.matrix, material: prim.material,
    pos: { data: Float32Array.from(npos), count: npos.length / 3 },
    uv: nuv ? { data: Float32Array.from(nuv) } : null,
    nrm: nnrm ? { data: Float32Array.from(nnrm) } : null,
    indices: Uint32Array.from(nidx),
  };
}

// Decimate `prims` to roughly `targetTris` by clustering. Returns { prims, cell, before, after }.
function decimate(prims, targetTris, opts) {
  const before = prims.reduce((s, p) => s + p.indices.length / 3, 0);
  if (before <= targetTris) return { prims, cell: 0, before, after: before };
  const { lo, hi } = bounds(prims);
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const fixed = opts && opts.cell;

  const tryCell = (cell) => {
    const rep = new Map();                 // cellKey -> [sumX,sumY,sumZ,count]
    for (const p of prims) { const d = p.pos.data; for (let i = 0; i < d.length; i += 3) { const k = cellKey(d[i], d[i + 1], d[i + 2], cell, lo); const r = rep.get(k); if (r) { r[0] += d[i]; r[1] += d[i + 1]; r[2] += d[i + 2]; r[3]++; } else rep.set(k, [d[i], d[i + 1], d[i + 2], 1]); } }
    for (const r of rep.values()) { r[0] /= r[3]; r[1] /= r[3]; r[2] /= r[3]; }
    const out = []; let t = 0;
    for (const p of prims) { const np = collapsePrim(p, cell, lo, rep); if (np) { out.push(np); t += np.indices.length / 3; } }
    return { out, t };
  };

  // Binary-search the cell size (bigger cell = fewer triangles) unless one is pinned. Keep the iteration
  // whose triangle count lands CLOSEST to the target, not merely the last one - the search can end on an
  // overshoot, and returning that would coarsen the mesh far more than asked.
  if (fixed) { const r = tryCell(fixed); return { prims: r.out, cell: fixed, before, after: r.t }; }
  let loC = span / 4000, hiC = span / 8, best = null, bestErr = Infinity;
  for (let it = 0; it < 10; it++) {
    const cell = Math.sqrt(loC * hiC);
    const r = tryCell(cell);
    const err = Math.abs(r.t - targetTris);
    if (err < bestErr) { bestErr = err; best = { out: r.out, t: r.t, cell }; }
    if (r.t > targetTris) loC = cell; else hiC = cell;
    if (err < targetTris * 0.08) break;
  }
  return { prims: best.out, cell: best.cell, before, after: best.t };
}

module.exports = { decimate };

// Self-check: a fine NxN grid mesh decimated to a quarter keeps its bounds (coverage) and sheds triangles.
if (require.main === module) {
  const N = 100, pos = [], idx = [];
  for (let y = 0; y <= N; y++) for (let x = 0; x <= N; x++) pos.push(x, y, 0);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const a = y * (N + 1) + x, b = a + 1, c = a + N + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
  const prim = { matrix: null, material: 0, pos: { data: Float32Array.from(pos), count: pos.length / 3 }, uv: null, nrm: null, indices: Uint32Array.from(idx) };
  const before = idx.length / 3;
  const r = decimate([prim], before / 4);
  const b2 = bounds(r.prims);
  const assert = (c, m) => { if (!c) throw new Error("decimate self-check: " + m); };
  assert(r.after < before && r.after > 0, "triangles not reduced: " + r.after);
  assert(Math.abs(b2.lo[0]) < 2 && Math.abs(b2.hi[0] - N) < 2, "X coverage lost: " + b2.lo[0] + ".." + b2.hi[0]);
  assert(Math.abs(b2.hi[1] - N) < 2, "Y coverage lost: " + b2.hi[1]);
  for (const p of r.prims) for (let i = 0; i < p.indices.length; i += 3) assert(p.indices[i] !== p.indices[i + 1] && p.indices[i + 1] !== p.indices[i + 2] && p.indices[i] !== p.indices[i + 2], "degenerate triangle survived");
  console.log("decimate.js: " + before + " -> " + r.after + " tris, bounds kept, no degenerates - OK");

  // UV-split guard: a textured quad whose four vertices all fall in ONE coarse cell collapses to coincident
  // positions with DISTINCT indices (they differ only in UV). Those zero-area triangles have distinct
  // indices so the index test misses them, and a null longest edge used to skip the sliver test - so they
  // survived, and the mesh builder culled them as collinear, holing out whole dense GTA / de_dust2 tiles.
  // They must be dropped here instead.
  const quad = {
    matrix: null, material: 0,
    pos: { data: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), count: 4 },
    uv: { data: Float32Array.from([0, 0, 1, 0, 0, 1, 1, 1]) }, nrm: null,
    indices: Uint32Array.from([0, 1, 2, 1, 3, 2]),
  };
  const rq = decimate([quad], 1, { cell: 10 });    // cell 10 >> quad, so every vertex lands in one cell
  assert(rq.after === 0, "coincident UV-split triangles must be dropped, got " + rq.after);
  console.log("decimate.js: UV-split coincident-collapse guard OK");
}
