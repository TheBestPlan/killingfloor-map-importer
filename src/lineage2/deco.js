// The grass, and everything else Lineage 2 scatters over its terrain.
//
// A `TerrainInfo` carries `DecoLayers`, and each one is a static mesh plus a density map: a grey
// texture over the whole square whose level says how much of that mesh grows on a quad. The client
// scatters them at run time from a seed; there is no list of positions in the file, so the converter
// has to do the scattering itself.
//
// Killing Floor has no decoration layer, so what comes out is geometry: the instances of one layer
// inside one terrain patch are baked into a single static mesh. A blade is five triangles and a
// square holds tens of thousands of them - as actors that is hopeless, as sixty-odd merged meshes it
// is ordinary level geometry.
"use strict";

const { Rd } = require("../unreal/read");
const { readTags, tagsOf, pick, val, refTarget, TYPE } = require("./props");

// A `Range`/`RangeVector` is a tagged block of its own; only the numbers are wanted here.
function readRange(pkg, tag) {
  const out = { min: 0, max: 0 };
  if (!tag) return out;
  const { tags } = readTags(pkg, tag.at, tag.at + tag.size);
  for (const t of tags) {
    if (t.type === TYPE.Float) out[t.name === "Min" ? "min" : t.name === "Max" ? "max" : "_"] = val.float(pkg, t);
  }
  return out;
}
// The X of a RangeVector is enough: every layer measured scales the three axes together.
function readRangeVector(pkg, tag) {
  if (!tag) return { min: 1, max: 1 };
  const { tags } = readTags(pkg, tag.at, tag.at + tag.size);
  const x = tags.find((t) => t.name === "X");
  return x ? readRange(pkg, x) : { min: 1, max: 1 };
}

function readDecoLayers(pkg) {
  const info = pkg.exports.find((e) => pkg.classOf(e) === "TerrainInfo" && e.serialSize);
  if (!info) return [];
  const { tags } = tagsOf(pkg, info);
  const arr = pick(tags, "DecoLayers");
  if (!arr) return [];
  const r = new Rd(pkg.buf, arr.at);
  const n = r.cidx();
  const end = arr.at + arr.size;
  const out = [];
  for (let i = 0; i < n && r.pos < end; i++) {
    const sub = readTags(pkg, r.pos, end);
    if (!sub.tags.length || sub.pos <= r.pos) break;
    const by = Object.fromEntries(sub.tags.map((t) => [t.name, t]));
    const ref = (name) => (by[name] ? refTarget(pkg, val.ref(pkg, by[name])) : null);
    out.push({
      mesh: ref("StaticMesh"),
      densityMap: ref("DensityMap"),
      maxPerQuad: by.MaxPerQuad ? val.int(pkg, by.MaxPerQuad) : 0,
      density: readRange(pkg, by.DensityMultiplier),
      scale: readRangeVector(pkg, by.ScaleMultiplier),
      randomYaw: by.RandomYaw ? by.RandomYaw.bool : false,
      seed: by.Seed ? val.int(pkg, by.Seed) : 0,
      showOnInvisible: by.ShowOnInvisibleTerrain ? by.ShowOnInvisibleTerrain.bool : false,
    });
    r.pos = sub.pos;
  }
  return out;
}

// A small deterministic generator, so a square scatters the same way every time it is converted.
function rng(seed) {
  let s = (seed | 0) || 0x9e3779b9;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return ((s >>> 8) & 0xffffff) / 0x1000000;
  };
}

// Where one layer's meshes stand, in Lineage 2 world units.
//
// `density` is the layer's map read as a grey plane (layers.js readAlpha). The count for a quad is
// the map's level times `MaxPerQuad`, which is what the client's own scatter multiplies; the exact
// positions are not in the file and cannot be reproduced, only their density.
function scatter(terrain, layer, density, opts) {
  const step = Math.max(1, (opts && opts.step) || 1);
  const limit = (opts && opts.limit) || Infinity;
  const quads = terrain.width - 1;
  const out = [];
  if (!density || !layer.maxPerQuad) return out;

  // What the square would grow if nothing were capped. The cap has to thin the field evenly rather
  // than fill up and stop: stopping leaves the grass in the rows that happened to be walked first
  // and bare ground everywhere after them.
  const weightOf = (ix, iy) => {
    if (!layer.showOnInvisible && !terrain.quadVisible(ix, iy)) return 0;
    const dx = Math.min(density.width - 1, Math.round((ix / quads) * density.width));
    const dy = Math.min(density.height - 1, Math.round((iy / quads) * density.height));
    const d = density.data[dy * density.width + dx] / 255;
    return d <= 0.03 ? 0 : d;
  };
  let total = 0;
  for (let iy = 0; iy + step <= quads; iy += step) {
    for (let ix = 0; ix + step <= quads; ix += step) total += weightOf(ix, iy);
  }
  // `step` thins the grid the same way the terrain mesh does, so one blade stands in for the quads
  // that were skipped and the field keeps its density.
  total *= layer.maxPerQuad * step * step;
  const keep = total > limit ? limit / total : 1;

  const rand = rng(layer.seed * 7919 + quads);
  for (let iy = 0; iy + step <= quads; iy += step) {
    for (let ix = 0; ix + step <= quads; ix += step) {
      const d = weightOf(ix, iy);
      if (!d) continue;
      const want = d * layer.maxPerQuad * step * step * keep;
      let count = Math.floor(want);
      if (rand() < want - count) count++;
      for (let k = 0; k < count; k++) {
        const u = ix + rand() * step, v = iy + rand() * step;
        out.push({
          pos: vertexAt(terrain, u, v),
          yaw: layer.randomYaw ? rand() * Math.PI * 2 : 0,
          size: layer.scale.min + rand() * Math.max(0, layer.scale.max - layer.scale.min),
        });
      }
    }
  }
  return out;
}

// The terrain surface at a fractional grid position - the blade stands on the ground, not on the
// nearest corner of it.
function vertexAt(terrain, fx, fy) {
  const ix = Math.min(terrain.width - 2, Math.floor(fx)), iy = Math.min(terrain.height - 2, Math.floor(fy));
  const tx = fx - ix, ty = fy - iy;
  const a = terrain.vertex(ix, iy), b = terrain.vertex(ix + 1, iy);
  const c = terrain.vertex(ix, iy + 1), d = terrain.vertex(ix + 1, iy + 1);
  const z = a[2] * (1 - tx) * (1 - ty) + b[2] * tx * (1 - ty) + c[2] * (1 - tx) * ty + d[2] * tx * ty;
  return [a[0] + (b[0] - a[0]) * tx, a[1] + (c[1] - a[1]) * ty, z];
}

// The instances of one layer, baked into meshes. `raw` is the source mesh as readMesh gives it;
// `materials` are the refs its sections paint with. One mesh per bucket, so a bucket is what decides
// how the work is split - the terrain patch it belongs to.
function bakeInstances(raw, materials, instances, opts) {
  const scale = (opts && opts.scale) || 1;
  const maxTris = (opts && opts.maxTriangles) || 18000;
  const perInstance = raw.indices.length / 3;
  const meshes = [];
  let cur = null;

  const flush = () => {
    if (!cur || !cur.runs.some((r) => r.length)) { cur = null; return; }
    // A section is a contiguous span of the index buffer, so the runs are laid out one after another
    // and each section points at where its own started.
    cur.indices = [];
    cur.sections = [];
    cur.runs.forEach((run) => {
      const firstIndex = cur.indices.length;
      for (const i of run) cur.indices.push(i);
      cur.sections.push({
        firstIndex, firstVertex: 0,
        lastVertex: cur.vertices.length - 1, numFaces: run.length / 3,
      });
    });
    delete cur.runs;
    cur.radius = Math.hypot(
      cur.bbox.max[0] - cur.bbox.min[0], cur.bbox.max[1] - cur.bbox.min[1], cur.bbox.max[2] - cur.bbox.min[2]) / 2;
    cur.center = [0, 1, 2].map((a) => (cur.bbox.min[a] + cur.bbox.max[a]) / 2);
    meshes.push(cur);
    cur = null;
  };
  const start = (origin) => {
    cur = {
      origin, materials: materials.slice(), triangles: 0,
      vertices: [], uvs: [], colors: [], indices: [],
      runs: raw.sections.map(() => []),
      bbox: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
    };
  };

  for (const inst of instances) {
    if (!cur) start(inst.pos);
    else if (cur.triangles + perInstance > maxTris) { flush(); start(inst.pos); }
    const c = Math.cos(inst.yaw), s = Math.sin(inst.yaw), k = inst.size;
    const base = cur.vertices.length;
    for (let vi = 0; vi < raw.vertices.length; vi++) {
      const v = raw.vertices[vi];
      const x = v.pos[0] * k, y = v.pos[1] * k, z = v.pos[2] * k;
      const pos = [
        (inst.pos[0] + x * c - y * s - cur.origin[0]) * scale,
        (inst.pos[1] + x * s + y * c - cur.origin[1]) * scale,
        (inst.pos[2] + z - cur.origin[2]) * scale,
      ];
      for (let a = 0; a < 3; a++) {
        if (pos[a] < cur.bbox.min[a]) cur.bbox.min[a] = pos[a];
        if (pos[a] > cur.bbox.max[a]) cur.bbox.max[a] = pos[a];
      }
      const n = v.normal || [0, 0, 1];
      cur.vertices.push({ pos, normal: [n[0] * c - n[1] * s, n[0] * s + n[1] * c, n[2]] });
      cur.uvs.push(raw.uvs[vi] || [0, 0]);
      cur.colors.push([255, 255, 255, 255]);
    }
    // The source mesh's own section split is kept: a blade with two materials keeps both. The winding
    // is flipped, the same way a Lineage 2 mesh is flipped for Killing Floor everywhere else.
    raw.sections.forEach((sec, i) => {
      const run = cur.runs[i];
      for (let t = 0; t < sec.numFaces; t++) {
        const at = sec.firstIndex + t * 3;
        run.push(base + raw.indices[at], base + raw.indices[at + 2], base + raw.indices[at + 1]);
      }
    });
    cur.triangles += perInstance;
  }
  flush();
  return meshes;
}

module.exports = { readDecoLayers, scatter, bakeInstances, vertexAt };
