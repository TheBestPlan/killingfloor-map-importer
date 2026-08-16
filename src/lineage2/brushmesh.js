// Brush polygons -> static meshes.
//
// A Lineage 2 poly is a convex ring with the UE texture mapping on it: the texel coordinate of a
// vertex is `dot(vertex - Base, TextureU) + PanU`, divided by the texture's own width to land in
// 0..1. That is the same mapping the GoldSrc route solves for BSP surfaces, only here it is already
// in the file rather than derived from a plane.
//
// One mesh per texture, split when a mesh would pass the polygon limit KFEd crashes above.
"use strict";

const MAX_TRIS = 18000;                    // KFEd crashes over 20000; the GoldSrc route uses 19000

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Lineage 2 keeps its sky IN the level: the haze ring and the cloud plane are ordinary brushes
// wearing textures out of L2_Skies, sitting twenty thousand units up. They are the square's own sky
// and want to be drawn as one - unlit, and not something the player can walk into.
const SKY_PACKAGE = /^l2_skies$/i;
const isSky = (target) => !!(target && target.pkg && SKY_PACKAGE.test(target.pkg));

// An antiportal is a rendering hint - a box the engine uses to occlude what is behind it - and not a
// surface. Carried across as geometry it is a grey slab across the level.
const isAntiportal = (target) => !!(target && /antiportal/i.test(target.name || ""));

// Water. A square's sea is one brush polygon a kilometre across, and drawing it opaque puts a flat
// lid over the terrain: on 16_24 that lid IS what looked like flat ground with the real mountains
// poking through it, and the red stripes were the two fighting for the same depth. It is drawn
// see-through and it is not something to stand on.
const isWater = (target) => !!(target && /water|ocean/i.test((target.pkg || "") + "." + (target.name || "")));

// `resolve(target)` hands back { texRef, width, height } for a poly's texture, or null.
function buildBrushMeshes(polys, resolve, opts) {
  const scale = (opts && opts.scale) || 1;
  const groups = new Map();
  let antiportal = 0;
  for (const p of polys) {
    if (p.vertices.length < 3) continue;
    if (isAntiportal(p.texture)) { antiportal++; continue; }
    const key = p.texture ? p.texture.pkg + "." + p.texture.name : "(none)";
    if (!groups.has(key)) groups.set(key, { target: p.texture, polys: [] });
    groups.get(key).polys.push(p);
  }

  const meshes = [];
  let dropped = 0;
  for (const [key, g] of groups) {
    const water = isWater(g.target);
    const tex = resolve(g.target, { water });
    if (!tex || !tex.texRef) { dropped += g.polys.length; continue; }
    let cur = null;
    const flush = () => {
      if (!cur || !cur.indices.length) return;
      cur.sections = [{ firstIndex: 0, firstVertex: 0, lastVertex: cur.vertices.length - 1, numFaces: cur.indices.length / 3 }];
      cur.radius = Math.hypot(cur.bbox.max[0] - cur.bbox.min[0], cur.bbox.max[1] - cur.bbox.min[1], cur.bbox.max[2] - cur.bbox.min[2]) / 2;
      cur.center = [0, 1, 2].map((a) => (cur.bbox.min[a] + cur.bbox.max[a]) / 2);
      meshes.push(cur);
      cur = null;
    };
    const start = () => {
      cur = {
        key, sky: isSky(g.target), water, blend: tex.blend || "opaque",
        materials: [tex.texRef], vertices: [], uvs: [], colors: [], indices: [],
        bbox: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
        origin: [0, 0, 0],
      };
    };
    for (const p of g.polys) {
      if (!cur) start();
      if (cur.indices.length / 3 + p.vertices.length - 2 > MAX_TRIS) { flush(); start(); }
      const first = cur.vertices.length;
      for (const v of p.vertices) {
        const pos = [v[0] * scale, v[1] * scale, v[2] * scale];
        for (let k = 0; k < 3; k++) {
          if (pos[k] < cur.bbox.min[k]) cur.bbox.min[k] = pos[k];
          if (pos[k] > cur.bbox.max[k]) cur.bbox.max[k] = pos[k];
        }
        const rel = sub(v, p.base);
        cur.vertices.push({ pos, normal: p.normal });
        cur.uvs.push([
          (dot(rel, p.textureU) + (p.panU || 0)) / tex.width,
          (dot(rel, p.textureV) + (p.panV || 0)) / tex.height,
        ]);
        cur.colors.push([0, 0, 0, 255]);
      }
      // Fan, reversed: the ring is wound for the compiler's front face, and Killing Floor draws the
      // other way round - the same flip the GoldSrc meshes need.
      for (let i = 2; i < p.vertices.length; i++) {
        cur.indices.push(first, first + i, first + i - 1);
      }
    }
    flush();
  }
  const triangles = meshes.reduce((n, m) => n + m.indices.length / 3, 0);
  return { meshes, triangles, dropped, antiportal, groups: groups.size };
}

module.exports = { buildBrushMeshes };
