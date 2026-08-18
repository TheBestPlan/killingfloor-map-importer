// Unreal Engine 1 BSP nodes -> UE2.5 static meshes.
//
// The easiest source geometry of the three games this tool reads. Both engines are Unreal, so there
// is no handedness to mirror and no winding to reverse: a node's vertex ring is already in the order
// Killing Floor wants, and a texture axis is already an Unreal texture axis. What the node does NOT
// carry is a UV - the surface stores two vectors and a base point, and the texel coordinate is the
// projection of the vertex onto them, exactly as GoldSrc's texinfo works.
//
// Output is the shape build/mesh.js and quake3/mesh.js produce, so unreal/staticmesh.js serialises
// it unchanged:
//   [{ materials, vertices, uvs, uvs2, colors, indices, sections, bbox, center, radius, origin }]
"use strict";

const { PF } = require("./model");

// KFEd crashes importing a static mesh over 20000 polygons; the other routes settled on 19000.
const MAX_TRIS = 19000;
const MAX_VERTS = 60000;                       // the index stream is 16-bit
const CELL = +(process.env.KF_CELL || 2048);   // spatial chunk size in Unreal units; 0 = off

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// Three points on one line make a triangle of no area: it draws nothing, but Karma reads the
// collision tree as the world and a zero-length face normal is a NaN contact that throws ragdolls
// out of the level (build/mesh.js has the full story).
// The threshold is an AREA, not the exactly-collinear test the other routes use: a UE1 node's ring
// carries the T-junction vertices of everything coplanar with it, and the slivers that fall out of a
// fan over one are thin rather than flat - 411 of TO-Crossfire's 24257 triangles measure under a
// square unit. Cross product length is twice the area, so 1.0 here is half a square Unreal unit.
const collinear = (a, b, c) => {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  return nx * nx + ny * ny + nz * nz <= 1.0;
};

// opts: {
//   scale, texOf(iSurf) -> { ref, kind, origWidth, origHeight } | null,
//   skip(iSurf) -> bool          surfaces cut out entirely (the sky, the tool brushes)
//   zoneOf(node) -> tag|null     geometry that must not be merged into the world (the sky room)
//   lightUV(iSurf, worldPoint) -> [u, v] | null
//   lightPage(iSurf) -> number | undefined
// }
function buildMeshes(model, opts) {
  const S = opts.scale;
  const stats = { nodes: 0, faces: 0, skipped: 0, noMaterial: 0, sky: 0, triangles: 0, flat3: 0, twoSided: 0 };
  const surfaces = [];

  for (const node of model.nodes) {
    stats.nodes++;
    if (node.numVertices < 3) continue;
    const surf = model.surfs[node.iSurf];
    if (!surf) { stats.skipped++; continue; }
    stats.faces++;
    if (opts.skip && opts.skip(node.iSurf, surf)) { stats.sky++; continue; }
    if (surf.polyFlags & PF.Invisible) { stats.skipped++; continue; }
    const tex = opts.texOf(node.iSurf, surf);
    if (!tex || !tex.ref) { stats.noMaterial++; continue; }

    const base = model.points[surf.pBase];
    const axisU = model.vectors[surf.vTextureU];
    const axisV = model.vectors[surf.vTextureV];
    if (!base || !axisU || !axisV) { stats.skipped++; continue; }

    const ring = [];
    for (let i = 0; i < node.numVertices; i++) {
      const v = model.verts[node.iVertPool + i];
      const p = v && model.points[v.pVertex];
      if (!p) { ring.length = 0; break; }
      const rel = sub(p, base);
      // Texel coordinates: the projection onto the surface's two axes, panned, over the texture's
      // own size. UE1 stores the pan in whole texels of the ORIGINAL texture, so a texture that had
      // to be resampled to a power of two is measured in its original size here too.
      const u = dot(rel, axisU) + surf.panU;
      const w = dot(rel, axisV) + surf.panV;
      ring.push({
        pos: [p[0] * S, p[1] * S, p[2] * S],
        uv: [u / (tex.origWidth || tex.width || 256), w / (tex.origHeight || tex.height || 256)],
        uv2: opts.lightUV ? opts.lightUV(node.iSurf, p) : null,
      });
    }
    if (ring.length < 3) { stats.skipped++; continue; }

    // The fan is emitted against the stored ring order, and the normal is the ring's own, negated.
    //
    // A node's vertex ring runs the opposite way round from what Killing Floor calls the front of a
    // static mesh triangle: emit it as stored and every surface in the level faces away from the
    // room it encloses. The result is not an empty screen - the near walls and the floor drop out
    // and the backs of the level's far side show through the holes, which is exactly the "shredded"
    // frame TO-Blaze-of-Glory came back with.
    //
    // The check that settled it: rasterising the converted .rom offline from the client's own camera
    // with FRONT faces culled reproduced the broken frame shape for shape, so the geometry was never
    // missing - the client was drawing the half of it that faces the wrong way.
    //
    // The winding comes from the ring rather than from the node's plane, because a plane is a BSP
    // artefact: the tree flips nodes as it balances, so 12% of a stock map's rings run against their
    // own plane (8510 with, 1203 against on TO-Crossfire), while the ring still carries the winding
    // of the brush polygon it was cut from.
    //
    // Newell's sum rather than one cross product: a ring carries the T-junction vertices of every
    // surface coplanar with it, so its first three points are often nearly in line and their cross
    // product is noise.
    const rn = [0, 0, 0];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i].pos, q = ring[(i + 1) % ring.length].pos;
      rn[0] += (p[1] - q[1]) * (p[2] + q[2]);
      rn[1] += (p[2] - q[2]) * (p[0] + q[0]);
      rn[2] += (p[0] - q[0]) * (p[1] + q[1]);
    }
    const rl = Math.hypot(rn[0], rn[1], rn[2]) || 1;
    const normal = [-rn[0] / rl, -rn[1] / rl, -rn[2] / rl];
    const tris = [];
    for (let i = 2; i < ring.length; i++) {
      if (collinear(ring[0].pos, ring[i - 1].pos, ring[i].pos)) { stats.flat3++; continue; }
      tris.push(0, i, i - 1);
    }
    if (!tris.length) { stats.skipped++; continue; }
    // A two-sided surface is one polygon the engine draws from both sides; a static mesh has no
    // such flag on the geometry, so the back is a second set of triangles wound the other way.
    // Only for an opaque one: a see-through surface is drawn twice by a doubled ring, and a pane
    // blended with itself is a pane of the wrong colour. Those get TwoSided on the material.
    if ((surf.polyFlags & PF.TwoSided) && (!tex.kind || tex.kind === "opaque")) {
      stats.twoSided++;
      for (let i = tris.length - 3; i >= 0; i -= 3) tris.push(tris[i], tris[i + 2], tris[i + 1]);
    }
    stats.triangles += tris.length / 3;

    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const v of ring) for (let k = 0; k < 3; k++) { if (v.pos[k] < lo[k]) lo[k] = v.pos[k]; if (v.pos[k] > hi[k]) hi[k] = v.pos[k]; }
    surfaces.push({
      ring, tris, normal, matRef: tex.ref, kind: tex.kind,
      page: opts.lightPage ? opts.lightPage(node.iSurf) : undefined,
      tag: opts.zoneOf ? opts.zoneOf(node) : null,
      liquid: !!tex.liquid,
      mid: [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2),
    });
  }

  // Group by (tag or spatial cell, material, lightmap page): a mesh carries ONE material and reads
  // ONE atlas page, and a level-spanning mesh can never be frustum-culled.
  const cellOf = (s) => (CELL ? Math.floor(s.mid[0] / CELL) + "," + Math.floor(s.mid[1] / CELL) + "," + Math.floor(s.mid[2] / CELL) : "all");
  const byKey = new Map();
  for (const s of surfaces) {
    const cell = s.tag !== null && s.tag !== undefined ? "T" + s.tag : cellOf(s);
    const key = cell + "|" + s.matRef + "@" + (s.page === undefined ? -1 : s.page);
    let list = byKey.get(key);
    if (!list) { list = []; byKey.set(key, list); }
    list.push(s);
  }

  const meshes = [];
  for (const list of byKey.values()) {
    let cur = null;
    const start = () => {
      cur = {
        materials: [list[0].matRef], vertices: [], uvs: [], uvs2: [], colors: [], indices: [], sections: [],
        kind: list[0].kind, liquid: list[0].liquid,
      };
      if (list[0].page !== undefined) cur.lightPage = list[0].page;
      if (list[0].tag !== null && list[0].tag !== undefined) cur.tag = list[0].tag;
      meshes.push(cur);
    };
    for (const s of list) {
      if (!cur || cur.vertices.length + s.ring.length > MAX_VERTS ||
        cur.indices.length / 3 + s.tris.length / 3 > MAX_TRIS) start();
      const at = cur.vertices.length;
      for (const v of s.ring) {
        cur.vertices.push({ pos: v.pos, normal: s.normal });
        cur.uvs.push(v.uv);
        cur.uvs2.push(v.uv2 || [0, 0]);
        // The colour stream ADDS to whatever lights the mesh (GOTCHAS 4.10a); the map's own light
        // rides in the material instead, so this stays at zero.
        cur.colors.push([0, 0, 0, 255]);
      }
      for (const i of s.tris) cur.indices.push(at + i);
    }
  }

  // One section per mesh, because one material per mesh: multi-section world meshes are where
  // geometry goes missing in game.
  for (const m of meshes) {
    if (!m.vertices.length) continue;
    m.sections.push({
      f0: 0, firstIndex: 0, firstVertex: 0, lastVertex: m.vertices.length - 1,
      u4: 0, numFaces: m.indices.length / 3,
    });
  }

  // Re-centre every mesh on its own bounding box: a static mesh is authored in LOCAL space and the
  // engine culls it with a sphere around the ACTOR, so world-space vertices under an actor at the
  // origin claim a sphere in the wrong place and whole chunks never draw.
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

module.exports = { buildMeshes, MAX_TRIS };
