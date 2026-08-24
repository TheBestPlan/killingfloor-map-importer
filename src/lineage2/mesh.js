// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Reading a UStaticMesh out of a Lineage 2 package.
//
// Walked by hand against water.usx and then against the town packages: the object is byte for byte
// what Killing Floor stores, right up to the end of the wireframe index stream -
//
//   property block | FBox | FSphere | Sections | FBox | VertexStream | ColorStream | AlphaStream
//   | UVStreams | IndexStream1 | IndexStream2
//
// - and only the collision after it differs. Interlude keeps FStaticMeshCollisionTriangle there
// (the face plane plus three edge planes, 68 bytes each), Killing Floor a kDOP tree. That tail is
// never read: the converter builds its own kDOP from the triangles, which it has to do anyway.
"use strict";

const { Rd } = require("../unreal/read");
const { readTags, pick, all, val, refTarget, TYPE } = require("./props");

// The Materials array: one entry per section, each a nested tagged block naming the material.
function readMaterials(pkg, tag) {
  const r = new Rd(pkg.buf, tag.at);
  const n = r.cidx();
  const out = [];
  for (let i = 0; i < n; i++) {
    const { tags, pos } = readTags(pkg, r.pos, tag.at + tag.size);
    const m = pick(tags, "Material");
    out.push({
      material: m ? refTarget(pkg, val.ref(pkg, m)) : null,
      collision: !!(pick(tags, "EnableCollision") || {}).bool,
    });
    r.pos = pos;
  }
  return out;
}

function readMesh(pkg, exp) {
  const end = exp.serialOffset + exp.serialSize;
  const { tags, pos } = readTags(pkg, exp.serialOffset, end);
  const matTag = tags.find((t) => t.name === "Materials" && t.type === TYPE.Array);
  const materials = matTag ? readMaterials(pkg, matTag) : [];

  const r = new Rd(pkg.buf, pos);
  const bbox = { min: r.vec(), max: r.vec(), valid: r.u8() };
  const center = r.vec(), radius = r.f32();

  const sections = r.array((x) => ({
    f0: x.i32(), firstIndex: x.u16(), firstVertex: x.u16(),
    lastVertex: x.u16(), u4: x.u16(), numFaces: x.u16(),
  }));
  r.vec(); r.vec(); r.u8();                          // the bounding box again

  const vertices = r.array((x) => ({ pos: x.vec(), normal: x.vec() }));
  r.i32();                                           // revision
  const colors = r.array((x) => [x.u8(), x.u8(), x.u8(), x.u8()]);
  r.i32();
  const alphas = r.array((x) => [x.u8(), x.u8(), x.u8(), x.u8()]);
  r.i32();
  const uvStreams = r.array((x) => {
    const uv = x.array((y) => [y.f32(), y.f32()]);
    x.i32(); x.i32();                                // CoordIndex, revision
    return uv;
  });
  const indices = r.array((x) => x.u16());
  r.i32();

  // Anything past here is the collision, which is regenerated rather than read - so the walk is
  // checked against what it HAS covered instead of against the end of the object.
  if (!vertices.length || !indices.length) throw new Error(exp.name + ": no geometry");
  if (r.pos > end) throw new Error(exp.name + ": walked " + (r.pos - end) + " bytes past the object");

  void alphas;
  return {
    name: exp.name,
    materials, sections, vertices, colors, indices,
    uvs: uvStreams[0] || [],
    uvCount: uvStreams.length,
    bbox, center, radius,
  };
}

// The mesh as unreal/staticmesh.js wants it: one material ref per section, colours per vertex, and
// UVs that exist for every vertex. `materialRefs` is what the caller resolved the textures to.
function toKFMesh(m, materialRefs, opts) {
  const scale = (opts && opts.scale) || 1;
  const vertices = m.vertices.map((v) => ({
    pos: [v.pos[0] * scale, v.pos[1] * scale, v.pos[2] * scale],
    normal: v.normal,
  }));
  // A mesh with no colour stream is lit by the level alone; white is the neutral value for a stream
  // that is ADDED to it, so an absent one becomes black rather than white (GOTCHAS 4.10).
  const colors = vertices.map((_, i) => m.colors[i] || [0, 0, 0, 255]);
  const uvs = vertices.map((_, i) => m.uvs[i] || [0, 0]);
  const bbox = {
    min: m.bbox.min.map((v) => v * scale),
    max: m.bbox.max.map((v) => v * scale),
  };
  return {
    materials: materialRefs,
    vertices, colors, uvs, indices: m.indices,
    sections: m.sections.map((s) => ({
      firstIndex: s.firstIndex, firstVertex: s.firstVertex,
      lastVertex: s.lastVertex, numFaces: s.numFaces,
    })),
    bbox,
    center: m.center.map((v) => v * scale),
    radius: m.radius * scale,
  };
}

// A StaticMeshInstance's baked vertex colours, in file order (B,G,R,A) so they can go straight back
// out through the Killing Floor writer.
//
// Worth almost nothing on this client, and that is the finding rather than a bug: of 16_12's 1907
// instances only 53 carry a single lit vertex, mean channel 0.6. Lineage 2's baked lighting lives in
// the four megabytes of per-light records AFTER the colour array - a different subsystem - not in
// the array Killing Floor reads. What is here is carried; the rest of the level's light is the zone.
function readInstanceColors(pkg, exp) {
  if (!exp || !exp.serialSize) return null;
  const r = new Rd(pkg.buf, exp.serialOffset);
  const end = exp.serialOffset + exp.serialSize;
  r.cidx();                                          // property block: "None"
  const n = r.cidx();
  if (n <= 0 || r.pos + n * 4 > end) return null;
  const out = new Array(n);
  let any = 0;
  for (let i = 0; i < n; i++) {
    const b = r.u8(), g = r.u8(), rr = r.u8(), a = r.u8();
    if (b || g || rr) any++;
    out[i] = [b, g, rr, a];
  }
  return any ? out : null;
}

module.exports = { readMesh, toKFMesh, readInstanceColors };
