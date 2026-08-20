// Quake 3 BSP faces -> UE2.5 static meshes.
//
// The Quake 3 side of this is easier than GoldSrc's and harder in one place. Easier, because a
// vertex already carries its texture UV, its lightmap UV and a normal - nothing has to be projected
// from a plane. Harder, because a third of a map is not polygons: type 2 faces are bezier patches
// that have to be tessellated, and type 3 are triangle soups that share vertices freely.
//
// Output is the same shape build/mesh.js produces, so unreal/staticmesh.js serializes it unchanged:
//   [{ materials, vertices, uvs, uvs2, colors, indices, sections, bbox, center, radius, origin }]
"use strict";

const { FACE, tessellatePatch } = require("./bsp");

// KFEd crashes importing a static mesh over 20000 polygons; the GoldSrc route settled on 19000.
const MAX_TRIS = 19000;
const MAX_VERTS = 60000;                       // the index stream is 16-bit
const CELL = +(process.env.KF_CELL || 2048);   // spatial chunk size in Unreal units; 0 = off

// Three points on one line make a triangle of no area: it draws nothing, but Karma reads the
// collision tree as the world and a zero-length face normal is a NaN contact that throws ragdolls
// out of the level. See build/mesh.js for the full story.
const collinear = (a, b, c) => {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  return nx * nx + ny * ny + nz * nz <= 1e-6;
};

// One face, ready to be packed into a mesh: its own vertices plus indices into them.
function surfaceOf(bsp, face, offset, S, patchLevel, tcScale) {
  const toUE = (p) => [(p[0] + offset[0]) * S, -(p[1] + offset[1]) * S, (p[2] + offset[2]) * S];
  const lit = face.lmIndex >= 0;
  // `tcMod scale` from the shader, baked in: the terrain shaders draw their rock at 0.125, and
  // without it the ground wears a texture eight times too big.
  const su = tcScale ? tcScale[0] : 1, sv = tcScale ? tcScale[1] : 1;
  const conv = (v) => ({
    pos: toUE(v.pos),
    normal: [v.normal[0], -v.normal[1], v.normal[2]],
    uv: [v.uv[0] * su, v.uv[1] * sv],
    uv2: lit ? [v.lm[0], v.lm[1]] : [0, 0],
    color: v.color,
  });

  if (face.type === FACE.PATCH) {
    const t = tessellatePatch(bsp, face, patchLevel);
    return { verts: t.verts.map(conv), indices: t.indices };
  }
  if (face.type !== FACE.POLYGON && face.type !== FACE.MESH) return null;   // 4 is a billboard flare
  const verts = [];
  for (let i = 0; i < face.nVertexes; i++) verts.push(conv(bsp.vertex(face.vertex + i)));
  const indices = [];
  for (let i = 0; i < face.nMeshverts; i++) indices.push(bsp.meshverts[face.meshvert + i]);
  return { verts, indices };
}

// opts: { scale, texOf(index) -> {ref, kind, ...}|null, patchLevel, separate: Map(model -> tag) }
function buildMeshes(bsp, opts) {
  const S = opts.scale;
  const patchLevel = opts.patchLevel || 4;
  const separate = opts.separate || new Map();

  // The world, then every entity that owns a brush model of its own.
  const jobs = [{ model: bsp.models[0], offset: [0, 0, 0] }];
  for (const ent of bsp.entities) {
    const mm = /^\*(\d+)$/.exec(ent.model || "");
    if (!mm) continue;
    const sm = bsp.models[+mm[1]];
    if (!sm || sm.nFaces <= 0) continue;
    const org = ent.origin ? ent.origin.trim().split(/\s+/).map(Number) : [0, 0, 0];
    jobs.push({
      model: sm, offset: [org[0] || 0, org[1] || 0, org[2] || 0], ent: separate.get(+mm[1]),
      classname: ent.classname || "",
    });
  }

  const stats = { faces: 0, skipped: 0, billboards: 0, patches: 0, triangles: 0, flat3: 0, sky: 0, liquid: 0, reoriented: 0, layers: 0 };
  const surfaces = [];
  for (const job of jobs) {
    for (let fi = job.model.face; fi < job.model.face + job.model.nFaces; fi++) {
      const face = bsp.faces[fi];
      if (!face) continue;
      stats.faces++;
      if (face.type === FACE.BILLBOARD) { stats.billboards++; continue; }
      const tex = opts.texOf(face.texture);
      // Sky brushes must not become geometry: they would seal the level with a lid and hide the
      // cube behind it. The holes they leave are exactly the view onto the skybox.
      if (tex && tex.kind === "sky") { stats.sky++; continue; }
      if (!tex || !tex.ref) { stats.skipped++; continue; }
      const s = surfaceOf(bsp, face, job.offset, S, patchLevel, tex.tcScale);
      if (!s || s.verts.length < 3 || s.indices.length < 3) { stats.skipped++; continue; }
      if (face.type === FACE.PATCH) stats.patches++;
      if (tex.liquid) stats.liquid++;

      // Reversed winding: Quake -> Unreal mirrors Y, and a mirror flips triangle orientation as the
      // rasteriser sees it, so the original order presents every face back-first and back-face
      // culling removes it.
      //
      // Reversing blindly is not enough, because a Quake 3 face is not always wound consistently:
      // on q3ctf2, 33 of 24939 polygon triangles run the OTHER way from their own siblings, spread
      // over 15 faces. Those 33 come out facing away and leave exactly what they are - a triangular
      // hole in a floor or a wall, with the room behind showing through. So each triangle is
      // oriented against the face's own normal first, and the mirror is applied to that.
      const fn = face.normal;
      const oriented = fn && (fn[0] || fn[1] || fn[2]);
      const tris = [];
      for (let i = 0; i + 2 < s.indices.length; i += 3) {
        const a = s.indices[i], b = s.indices[i + 1], c = s.indices[i + 2];
        if (!s.verts[a] || !s.verts[b] || !s.verts[c]) continue;
        if (collinear(s.verts[a].pos, s.verts[b].pos, s.verts[c].pos)) { stats.flat3++; continue; }
        let flip = true;
        if (oriented) {
          // The vertices are already in Unreal space (Y mirrored), so the face normal is mirrored
          // too before they are compared.
          const A = s.verts[a].pos, B = s.verts[b].pos, C = s.verts[c].pos;
          const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
          const e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
          const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
          // The mirror negates the sign of this dot product, so the majority of a well-wound face
          // lands on d > 0 and it is the ODD ones - the handful wound the other way - that keep the
          // file's order.
          const d = cr[0] * fn[0] - cr[1] * fn[1] + cr[2] * fn[2];
          if (d < 0) { flip = false; stats.reoriented++; }
        }
        if (flip) tris.push(a, c, b); else tris.push(a, b, c);
      }
      if (!tris.length) { stats.skipped++; continue; }
      stats.triangles += tris.length / 3;

      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const v of s.verts) for (let k = 0; k < 3; k++) { if (v.pos[k] < lo[k]) lo[k] = v.pos[k]; if (v.pos[k] > hi[k]) hi[k] = v.pos[k]; }
      const mid = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
      surfaces.push({
        verts: s.verts, tris, matRef: tex.ref, page: face.lmIndex >= 0 ? face.lmIndex : -1,
        liquid: !!tex.liquid, ent: job.ent, kind: tex.kind, mid,
      });

      // A terrain surface is drawn TWICE: the base rock, then the second rock over it, blended by
      // the vertex alpha the mapper painted (`alphaGen vertex`). The second pass is the same
      // triangles with the other texture and its own UV scale; what makes it a blend rather than a
      // second opaque coat is the material convert.js hangs on it.
      if (tex.overlay) {
        const su = tex.overlay.tcScale ? tex.overlay.tcScale[0] : 1;
        const sv = tex.overlay.tcScale ? tex.overlay.tcScale[1] : 1;
        const base = tex.tcScale || [1, 1];
        const verts = s.verts.map((v) => Object.assign({}, v, {
          // s.verts already carry the BASE stage's scale, so the overlay's is applied relative to it.
          uv: [(v.uv[0] / (base[0] || 1)) * su, (v.uv[1] / (base[1] || 1)) * sv],
        }));
        surfaces.push({
          verts, tris: tris.slice(), matRef: tex.overlay.texRef, page: -1,
          liquid: false, ent: job.ent, kind: "normal", overlay: true, mid,
        });
        stats.layers++;
      }
    }
  }

  // Group by (spatial cell, material, lightmap page). A mesh carries ONE material and reads ONE
  // atlas page, and a level-spanning mesh can never be frustum-culled - so both axes matter.
  const cellOf = (s) => (CELL ? Math.floor(s.mid[0] / CELL) + "," + Math.floor(s.mid[1] / CELL) : "all");
  const byCell = new Map();
  for (const s of surfaces) {
    // A door has to stay one mesh: chunking it by the grid would give it halves that open apart.
    const cell = s.ent !== undefined ? "E" + s.ent : (s.liquid ? "W|" : s.overlay ? "L|" : "") + cellOf(s);
    const key = cell + "|" + s.matRef + "@" + s.page;
    let list = byCell.get(key);
    if (!list) { list = []; byCell.set(key, list); }
    list.push(s);
  }

  const meshes = [];
  // Quake 3 doubles its own baked light on load (r_mapOverBrightBits), vertex colours included.
  const vertexGain = opts.vertexGain === undefined ? 2 : opts.vertexGain;
  for (const list of byCell.values()) {
    const lit = list[0].page >= 0;
    let cur = null;
    const start = () => {
      cur = {
        materials: [list[0].matRef], vertices: [], uvs: [], uvs2: [], colors: [], indices: [], sections: [],
        liquid: list[0].liquid, kind: list[0].kind, overlay: !!list[0].overlay,
      };
      if (list[0].page >= 0) cur.lightPage = list[0].page;
      if (list[0].ent !== undefined) cur.ent = list[0].ent;
      meshes.push(cur);
    };
    for (const s of list) {
      if (!cur || cur.vertices.length + s.verts.length > MAX_VERTS ||
        cur.indices.length / 3 + s.tris.length / 3 > MAX_TRIS) start();
      const base = cur.vertices.length;
      for (const v of s.verts) {
        cur.vertices.push({ pos: v.pos, normal: v.normal });
        cur.uvs.push(v.uv);
        cur.uvs2.push(v.uv2);
        // The colour stream is ADDED to whatever lights the mesh, not multiplied by it.
        //
        // A lightmapped surface therefore ships it at zero: its light is already in the material,
        // as a Combiner over the atlas, and a second copy here would be a light nobody can turn
        // down. A surface with NO lightmap has nothing in its material - a misc_model statue, a
        // flame, a light panel - and Quake 3 lights exactly those from this same per-vertex colour,
        // sampled out of its light grid at compile time. So carry it: the statues in q3dm1's
        // courtyard keep their shading instead of standing there as flat white cut-outs.
        //
        // The ALPHA is the terrain's blend weight: `alphaGen vertex` paints it per vertex, and the
        // overlay pass's material reads it through an Engine.VertexColor. On every other surface it
        // is 255 and nothing looks at it.
        const weight = s.overlay ? (v.color[3] === undefined ? 255 : v.color[3]) : 255;
        if (lit) cur.colors.push([0, 0, 0, weight]);
        else {
          // FColor is B, G, R, A on disk (GOTCHAS 1.8).
          const g2 = (c) => Math.min(255, Math.round(c * vertexGain));
          cur.colors.push([g2(v.color[2]), g2(v.color[1]), g2(v.color[0]), weight]);
        }
      }
      for (const i of s.tris) cur.indices.push(base + i);
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
