// GoldSrc BSP -> UE2.5 UStaticMesh.
//
// The world becomes one or more static meshes instead of BSP. That is how every working manual
// CS->KF port is built, it is visible in all of KFEd's viewports, and it sidesteps the BSP
// invariants that the engine reads without bounds-checking.
//
// Lighting rides along as per-vertex colour: triangles are subdivided until their edges are short
// enough that sampling the GoldSrc lightmap at the corners approximates the original luxel grid.
"use strict";

// KFEd CRASHES on importing a static mesh with more than 20000 polygons (reported by a mapper who
// hit it, and the reason big maps have to be emitted in pieces). 19000 leaves headroom; the 16-bit
// IndexStream would allow 21845, so this limit - not the format - is what governs.
const MAX_TRIS = 19000;
const MAX_VERTS = MAX_TRIS * 3;
const MAX_EDGE = 96;              // Unreal units; ~3 luxels at scale 2
const CELL = +(process.env.KF_CELL || 2048);   // grid cell for spatial chunking (Unreal units); 0 = off
// One material per mesh. Multi-section meshes are where geometry goes missing in game.
const ONE_SECTION = process.env.KF_MULTISECTION !== "1";
const FLAT_VCOL = process.env.KF_VCOL === undefined ? null : Math.max(0, Math.min(255, +process.env.KF_VCOL));

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Bilinear sample of a face's GoldSrc lightmap at a world position (in GoldSrc space).
function sampleLight(hl, ti, pHL) {
  if (!hl) return [128, 128, 128];
  const s = dot(pHL, ti.s) + ti.sShift, t = dot(pHL, ti.t) + ti.tShift;
  let fx = s / 16 - hl.baseS, fy = t / 16 - hl.baseT;
  fx = Math.max(0, Math.min(hl.width - 1, fx));
  fy = Math.max(0, Math.min(hl.height - 1, fy));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(hl.width - 1, x0 + 1), y1 = Math.min(hl.height - 1, y0 + 1);
  const ax = fx - x0, ay = fy - y0;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const v00 = hl.rgb[(y0 * hl.width + x0) * 3 + c], v10 = hl.rgb[(y0 * hl.width + x1) * 3 + c];
    const v01 = hl.rgb[(y1 * hl.width + x0) * 3 + c], v11 = hl.rgb[(y1 * hl.width + x1) * 3 + c];
    out[c] = Math.min(255, ((v00 * (1 - ax) + v10 * ax) * (1 - ay) + (v01 * (1 - ax) + v11 * ax) * ay) | 0);
  }
  return out;
}

// How much the GoldSrc lightmap varies across a face, as a luminance range 0..255. A face the
// compiler shaded flat gains nothing from extra vertices; one with a lamp pool or a shadow edge
// across it gains everything.
const LIGHT_CONTRAST = 20;
function lightContrast(hl) {
  if (!hl || hl.flat || !hl.width || !hl.height) return 0;
  let lo = 255, hi = 0;
  for (let i = 0; i < hl.width * hl.height; i++) {
    const L = (hl.rgb[i * 3] * 299 + hl.rgb[i * 3 + 1] * 587 + hl.rgb[i * 3 + 2] * 114) / 1000;
    if (L < lo) lo = L;
    if (L > hi) hi = L;
  }
  return hi - lo;
}

// Split a triangle until every edge is shorter than MAX_EDGE, so the baked light has somewhere to live.
function subdivide(tri, out, depth, maxDepth) {
  const cap = maxDepth === undefined ? 4 : maxDepth;
  const [a, b, c] = tri;
  const ab = dist(a.pos, b.pos), bc = dist(b.pos, c.pos), ca = dist(c.pos, a.pos);
  const longest = Math.max(ab, bc, ca);
  if (depth >= cap || longest <= MAX_EDGE) { out.push(tri); return; }
  const lerp = (p, q) => ({
    pos: mid(p.pos, q.pos),
    uv: [(p.uv[0] + q.uv[0]) / 2, (p.uv[1] + q.uv[1]) / 2],
    uv2: p.uv2 && q.uv2 ? [(p.uv2[0] + q.uv2[0]) / 2, (p.uv2[1] + q.uv2[1]) / 2] : null,
    hl: mid(p.hl, q.hl),
  });
  if (longest === ab) { const m = lerp(a, b); subdivide([a, m, c], out, depth + 1, cap); subdivide([m, b, c], out, depth + 1, cap); }
  else if (longest === bc) { const m = lerp(b, c); subdivide([a, b, m], out, depth + 1, cap); subdivide([a, m, c], out, depth + 1, cap); }
  else { const m = lerp(c, a); subdivide([a, b, m], out, depth + 1, cap); subdivide([m, b, c], out, depth + 1, cap); }
}

// How hard to split, by how much light the face actually carries. Measured over gg_dustwars'
// 3609 faces: 1702 are flat or nearly so, 652 vary by 20-40, 391 by 40-60, 864 by more. Splitting
// everything to the same depth cost 5x the triangles for detail that half the map has no use for.
const detailDepth = (contrast) => (contrast >= 90 ? 3 : contrast >= 40 ? 2 : contrast >= LIGHT_CONTRAST ? 1 : 0);

// Returns [{ materials, vertices, uvs, colors, indices, sections, bbox }]
function buildMeshes(map, opts) {
  const S = opts.scale;
  const texOf = opts.texByMiptex;
  const toUE = (p) => [p[0] * S, -p[1] * S, p[2] * S];

  // gather every face of the world plus every brush entity, with its origin applied
  const jobs = [{ model: map.models[0], offset: [0, 0, 0] }];
  // Entities the caller wants as meshes of their own: a door has to move and a pane of glass has to
  // break, so their faces must not be merged into the world's chunks. opts.separate maps a model
  // index to a tag; every triangle from that model carries the tag and ends up in its own mesh.
  const separate = opts.separate || new Map();
  for (const ent of map.entities) {
    const mm = /^\*(\d+)$/.exec(ent.model || "");
    if (!mm) continue;
    const sm = map.models[+mm[1]];
    if (!sm || sm.numfaces <= 0) continue;
    const org = ent.origin ? ent.origin.trim().split(/\s+/).map(Number) : [0, 0, 0];
    jobs.push({
      model: sm, offset: [org[0] || 0, org[1] || 0, org[2] || 0], top: sm.maxs[2],
      ent: separate.get(+mm[1]),
      // What makes a brush water is the ENTITY, not the texture. gg_33_mario's two pools are
      // func_water wearing `weg01` - an ordinary name, no `!` - so the texture test alone let both
      // facings of all 54 faces through and the pool z-fought into stripes.
      isWater: /^func_water$/i.test(ent.classname || ""),
      // Glass and anything else the mapper drew with a render mode: the faces keep their texture
      // but wear a translucent material instead of the plain one.
      mat: opts.materialOf ? opts.materialOf(ent) : null,
    });
  }

  // 256-bin histogram of luxel brightness, so a percentile can be taken later without keeping
  // every sample.
  const stats = { faces: 0, skipped: 0, triangles: 0, subdivided: 0, sky: 0, lumHist: new Int32Array(256), lumN: 0, lumR: 0, lumG: 0, lumB: 0 };
  const byMaterial = new Map();                        // group key -> triangles
  const groupInfo = new Map();                         // group key -> { matRef, page }

  for (const job of jobs) {
    for (let fi = job.model.firstface; fi < job.model.firstface + job.model.numfaces; fi++) {
      const face = map.faces[fi];
      if (!face) continue;
      stats.faces++;
      const ti = map.texinfo[face.texinfo];
      const tex = texOf.get(ti.miptex);
      if (!tex || tex.kind === "tool" || !tex.ref) { stats.skipped++; continue; }
      // Sky brushes must NOT become geometry. Their texture is the 16x16 `sky` placeholder from
      // halflife.wad, so they turn into a pale lid sealing the level and hiding the skybox cube
      // behind it - the "white sky" that survived every fix aimed at the sky itself. Cut them out
      // and the holes they leave are exactly the view onto the real skybox.
      if (tex.kind === "sky") { stats.sky = (stats.sky || 0) + 1; continue; }
      const isWater = tex.kind === "liquid" || !!job.isWater;
      const ring = map.faceVertices(face);
      if (ring.length < 3) { stats.skipped++; continue; }
      // A GoldSrc water brush is a closed box, and every one of its planes is stored TWICE - once
      // per facing, because water is drawn from inside as well. Keep the wrong ones and the pool
      // becomes two translucent sheets a couple of hundred units apart that z-fight into stripes at
      // any distance: that is the "layered water textures".
      //
      // Two filters, both needed. The normal test drops the inward-facing copy of every plane; the
      // height test drops the box's floor, whose surviving copy also points up. The height of the
      // brush is only known for a brush entity - a `!` texture on a world brush is a river surface
      // that has no box around it, so there the normal test alone is right.
      if (isWater) {
        if (map.faceNormal(face)[2] < 0.5) { stats.waterHidden = (stats.waterHidden || 0) + 1; continue; }
        if (job.top !== undefined && Math.max(ring[0][2], ring[1][2], ring[2][2]) < job.top - 1) {
          stats.waterHidden = (stats.waterHidden || 0) + 1; continue;
        }
      }
      const hl = map.faceLightmapRGB(face);
      const O = job.offset;

      // The face's block in the lightmap atlas, if this map is being lit from its own luxels.
      // `p` is in the entity's local space, which is exactly the space texinfo measures in - the
      // same reason `s`/`t` below subtract the origin back out.
      const lmPlan = opts.lightmap ? opts.lightmap.byFace.get(fi) : null;

      const pts = ring.map((p) => {
        const world = add(p, O);
        const s = dot(world, ti.s) + ti.sShift - dot(O, ti.s);
        const t = dot(world, ti.t) + ti.tShift - dot(O, ti.t);
        return {
          pos: toUE(world),
          uv: [s / tex.origWidth, t / tex.origHeight],
          uv2: lmPlan ? opts.lightmap.uvOf(lmPlan, ti, p) : null,
          hl: sampleLight(hl, ti, p),
        };
      });

      // Luxel brightness of the map, so the zone's ambient can be derived from GoldSrc's own
      // lighting rather than a guessed constant. Sample the whole lightmap of the face: sampling
      // at the vertices instead clusters on face edges and over-weights small bright faces.
      if (hl && !hl.flat) {
        for (let li = 0; li < hl.width * hl.height; li++) {
          const b = Math.round((hl.rgb[li * 3] + hl.rgb[li * 3 + 1] + hl.rgb[li * 3 + 2]) / 3);
          stats.lumHist[Math.min(255, Math.max(0, b))]++;
          stats.lumR += hl.rgb[li * 3]; stats.lumG += hl.rgb[li * 3 + 1]; stats.lumB += hl.rgb[li * 3 + 2];
          stats.lumN++;
        }
      }

      const N = map.faceNormal(face);
      const normal = [N[0], -N[1], N[2]];
      // A mesh carries ONE material, so faces group by the atlas page as well: two faces sharing a
      // texture but packed into different pages cannot share a Combiner.
      const matRef = (job.mat && job.mat(tex)) || tex.ref;
      const key = lmPlan ? matRef + "@" + lmPlan.page : String(matRef);
      if (!groupInfo.has(key)) groupInfo.set(key, { matRef, page: lmPlan ? lmPlan.page : -1 });
      const list = byMaterial.get(key) || byMaterial.set(key, []).get(key);
      if (isWater) stats.water = (stats.water || 0) + 1;
      // Static-mesh lighting in UE2 is per VERTEX (GOTCHAS 4.10), so a Build in KFEd can only put
      // light where this mesh has corners - and a CS face is up to 240 units across, which is how
      // a built map ends up with hard dark wedges at chunk boundaries instead of a gradient.
      // Splitting every face would multiply the triangle count ~25x; split only the faces GoldSrc
      // itself lit unevenly, since a face its own compiler shaded flat has nothing to lose.
      const depth = opts.lightDetail ? detailDepth(lightContrast(hl)) : 0;
      for (let i = 2; i < pts.length; i++) {
        const fan = [pts[0], pts[i - 1], pts[i]];
        if (opts.subdivide || depth) {
          const out = [];
          subdivide(fan, out, 0, opts.subdivide ? undefined : depth);
          if (out.length > 1) stats.subdivided++;
          // Same reversed winding as below: the Y mirror flips what the rasteriser sees, and the
          // subdivided path used to emit the original order and present every split face backwards.
          for (const tri of out) list.push({ tri: [tri[0], tri[2], tri[1]], normal, water: isWater, ent: job.ent });
          stats.triangles += out.length;
        } else {
          // Reversed winding. GoldSrc -> Unreal mirrors Y, and a mirror flips triangle orientation
          // as the rasteriser sees it, so emitting the ring in its original order presents every
          // face to the camera back-first and back-face culling removes it. The ground suffered
          // most visibly (nothing to stand on, sky showing through), but it hit every surface.
          list.push({ tri: [fan[0], fan[2], fan[1]], normal, water: isWater, ent: job.ent });
          stats.triangles++;
        }
      }
    }
  }

  // Chunk by a spatial grid first, then by material within each cell. A handful of level-spanning
  // meshes have bounding boxes that cover everything, so the engine can never frustum- or
  // occlusion-cull them and redraws the whole map every frame; one mesh per grid cell keeps each
  // box tight. CELL = 0 falls back to material-only grouping (the whole level in a few meshes).
  const cellOf = (t) => {
    if (!CELL) return "all";
    const c = t.tri[0].pos;
    return Math.floor(c[0] / CELL) + "," + Math.floor(c[1] / CELL);
  };
  const byCell = new Map();
  for (const [groupKey, tris] of byMaterial) {
    for (const t of tris) {
      // A door or a pane has to stay ONE mesh - chunking it by the grid would give a door two
      // halves that open independently.
      const key = t.ent !== undefined ? "E" + t.ent : (t.water ? "W|" : "") + cellOf(t);
      let cell = byCell.get(key);
      if (!cell) { cell = new Map(); byCell.set(key, cell); }
      let list = cell.get(groupKey);
      if (!list) { list = []; cell.set(groupKey, list); }
      list.push(t);
    }
  }

  const meshes = [];
  let cur = null;
  const startMesh = () => {
    cur = { materials: [], vertices: [], uvs: [], uvs2: [], colors: [], indices: [], sections: [], bbox: null };
    meshes.push(cur);
  };

  for (const cell of byCell.values()) {
    startMesh();
    for (const [groupKey, tris] of cell) {
      const { matRef: texRef, page: lightPage } = groupInfo.get(groupKey);
      // One material per mesh for the world (multi-section world meshes lost geometry in game),
      // but a door or a pane has to stay ONE actor - splitting it by material gave one door two
      // halves, each its own Mover.
      if (ONE_SECTION && cur.vertices.length && tris[0].ent === undefined) startMesh();
      if (tris.length && tris[0].water) cur.water = true;
      if (tris.length && tris[0].ent !== undefined) cur.ent = tris[0].ent;
      let i = 0;
      while (i < tris.length) {
        if (cur.vertices.length + 3 > MAX_VERTS || cur.indices.length / 3 >= MAX_TRIS) startMesh();
        const room = Math.min(Math.floor((MAX_VERTS - cur.vertices.length) / 3), MAX_TRIS - cur.indices.length / 3);
        const take = tris.slice(i, i + room);
        i += take.length;
        cur.materials.push(texRef);
        if (lightPage >= 0) cur.lightPage = lightPage;
        const firstIndex = cur.indices.length, firstVertex = cur.vertices.length;
        for (const t of take) {
          for (const v of t.tri) {
            cur.indices.push(cur.vertices.length);
            cur.vertices.push({ pos: v.pos, normal: t.normal });
            cur.uvs.push(v.uv);
            cur.uvs2.push(v.uv2 || [0, 0]);
            // KF_VCOL=<0..255> replaces the baked luxel with a flat value, to find out whether the
            // renderer is using this stream at all - a dynamically lit mesh that comes out white
            // has to be tested against a mesh whose colours cannot be the cause.
            // The colour stream is ADDED to whatever lights the mesh, not multiplied by it -
            // measured with three probe builds on gg_dustwars: colours 0 and no lights is black,
            // colours 0 with lights looks lit, colours 128 with the same lights burns to white.
            // So a dynamically lit map has to ship this stream at zero, or the baked GoldSrc luxel
            // (mean 128-180) is a second, uncontrollable light source on every surface - which is
            // why the sun could go from 20 to 150 without changing anything on screen.
            const flat = opts.flatColor === undefined ? FLAT_VCOL : opts.flatColor;
            cur.colors.push(flat === null ? [v.hl[2], v.hl[1], v.hl[0], 255] : [flat, flat, flat, 255]);
          }
        }
        cur.sections.push({
          f0: 0, firstIndex, firstVertex, lastVertex: Math.max(firstVertex, cur.vertices.length - 1),
          u4: 0, numFaces: take.length,
        });
      }
    }
  }

  // Re-centre every mesh on its own bounding box and hand the offset back as `origin`, for the
  // actor's Location.
  //
  // A static mesh is authored in LOCAL space; the engine culls it with a sphere centred on the
  // actor's Location. Emitting world-space vertices under an actor at (0,0,0) therefore claims a
  // sphere around the world origin with the chunk's small radius, and every chunk whose geometry
  // sits away from the origin is culled - which is why parts of the level (the ground worst of all,
  // since it spreads furthest) simply never drew, while the whole-level meshes it replaced did.
  for (const m of meshes) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const v of m.vertices) for (let c = 0; c < 3; c++) {
      if (v.pos[c] < lo[c]) lo[c] = v.pos[c];
      if (v.pos[c] > hi[c]) hi[c] = v.pos[c];
    }
    if (!m.vertices.length) { m.bbox = { min: [0, 0, 0], max: [0, 0, 0] }; m.center = [0, 0, 0]; m.radius = 0; m.origin = [0, 0, 0]; continue; }
    const origin = mul(add(lo, hi), 0.5);
    for (const v of m.vertices) v.pos = sub(v.pos, origin);
    m.origin = origin;
    m.bbox = { min: sub(lo, origin), max: sub(hi, origin) };
    m.center = [0, 0, 0];
    m.radius = dist(m.bbox.max, m.center);
  }

  return { meshes: meshes.filter((m) => m.vertices.length >= 3), stats };
}

module.exports = { buildMeshes, MAX_VERTS };
