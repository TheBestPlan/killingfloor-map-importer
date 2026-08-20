// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// UStaticMesh (UE2.5 / KF v128) reader and writer.
//
// Layout, worked out against the shipped meshes with a byte-exact round-trip as the oracle:
//
//   [UObject]    tagged property block (carries the Materials array)
//   [UPrimitive] FBox(25) + FSphere(16)
//   Sections     TArray<FStaticMeshSection>  14 bytes each
//   FBox(25)                                  bounding box again
//   VertexStream TArray<{FVector Pos, FVector Normal}> + INT Revision
//   ColorStream  TArray<FColor> + INT
//   AlphaStream  TArray<FColor> + INT
//   UVStreams    TArray<{ TArray<FMeshUVFloat> + INT + INT }>
//   IndexStream1 TArray<u16> + INT            the triangle list
//   IndexStream2 TArray<u16> + INT            wireframe indices
//   kDOP tree    cidx pad, TArray<FkDOPNode(32)>, TArray<FkDOPCollisionTriangle(6)>
//   RawTriangles TLazyArray<FStaticMeshTriangle>   INT skipOffset + cidx count + elements
//
// FStaticMeshTriangle is 36 + 4 + 4 + 24*numUV + 12 + 4 bytes: three positions, two ints, three
// UV pairs per UV set, three vertex colours, and a material index.
"use strict";

const { Writer } = require("./writer");
const { Rd } = require("./read");

function readProps(r, pkg) {
  const start = r.pos;
  for (let g = 0; g < 4000; g++) {
    const pname = pkg.names[r.cidx()];
    if (pname === "None" || pname === undefined) break;
    const info = r.u8();
    const type = info & 0x0f, sizeCode = (info >> 4) & 7, isArr = (info & 0x80) !== 0;
    if (type === 10) r.cidx();
    let size;
    if (sizeCode === 0) size = 1; else if (sizeCode === 1) size = 2; else if (sizeCode === 2) size = 4;
    else if (sizeCode === 3) size = 12; else if (sizeCode === 4) size = 16;
    else if (sizeCode === 5) size = r.u8(); else if (sizeCode === 6) size = r.u16(); else size = r.u32();
    if (isArr && type !== 3) r.u8();
    if (type !== 3) r.skip(size);
  }
  return pkg.buf.subarray(start, r.pos);          // kept verbatim; only the round-trip needs it
}

function readMesh(pkg, exp) {
  const r = new Rd(pkg.buf, exp.serialOffset);
  const end = exp.serialOffset + exp.serialSize;
  const props = readProps(r, pkg);
  const bbox = { min: r.vec(), max: r.vec(), valid: r.u8() };
  const bsphere = { center: r.vec(), radius: r.f32() };
  const sections = r.array((x) => ({
    f0: x.i32(), firstIndex: x.u16(), firstVertex: x.u16(), lastVertex: x.u16(), u4: x.u16(), numFaces: x.u16(),
  }));
  const bbox2 = { min: r.vec(), max: r.vec(), valid: r.u8() };
  const vertices = r.array((x) => ({ pos: x.vec(), normal: x.vec() }));
  const vertRevision = r.i32();
  const colors = r.array((x) => [x.u8(), x.u8(), x.u8(), x.u8()]);
  const colorRevision = r.i32();
  const alphas = r.array((x) => [x.u8(), x.u8(), x.u8(), x.u8()]);
  const alphaRevision = r.i32();
  const uvStreams = r.array((x) => {
    const uv = x.array((y) => [y.f32(), y.f32()]);
    return { uv, a: x.i32(), b: x.i32() };
  });
  const indices = r.array((x) => x.u16());
  const indexRevision = r.i32();
  const wireIndices = r.array((x) => x.u16());
  const wireRevision = r.i32();

  // kDOP: an empty leading array, then 32-byte nodes (AABB + int + two u16) and 8-byte collision
  // triangles (three vertex indices + material). Solved by search against 60 shipped meshes.
  const kdopPad = r.cidx();
  const kdopNodes = r.array((x) => ({ min: x.vec(), max: x.vec(), a: x.i32(), b: x.u16(), c: x.u16() }));
  const kdopTris = r.array((x) => ({ v: [x.u16(), x.u16(), x.u16()], mat: x.u16() }));

  r.i32();                                        // TLazyArray skip offset (absolute, recomputed)
  const nRaw = r.cidx();
  // FStaticMeshTriangle: three positions, the UV-set count, that many UV triples, three vertex
  // colours, then two ints (smoothing mask and material index).
  const rawTriangles = [];
  for (let i = 0; i < nRaw; i++) {
    const v = [r.vec(), r.vec(), r.vec()];
    const numUV = r.i32();
    const uv = [];
    for (let k = 0; k < 3 * numUV; k++) uv.push([r.f32(), r.f32()]);
    const col = [];
    for (let k = 0; k < 3; k++) col.push([r.u8(), r.u8(), r.u8(), r.u8()]);
    const smoothing = r.i32(), mat = r.i32();
    rawTriangles.push({ v, numUV, uv, col, smoothing, mat });
  }
  const tail = pkg.buf.subarray(r.pos, end);      // anything the layout above does not cover
  return {
    props, bbox, bsphere, sections, bbox2, vertices, vertRevision, colors, colorRevision,
    alphas, alphaRevision, uvStreams, indices, indexRevision, wireIndices, wireRevision,
    kdopPad, kdopNodes, kdopTris, rawTriangles, tail, exact: r.pos <= end && (end - r.pos) <= 32, over: r.pos - end,
  };
}

function writeMesh(pkg, m) {
  const w = new Writer(1 << 18);
  w.bytes(m.props);
  w.box(m.bbox.min, m.bbox.max, m.bbox.valid);
  w.sphere(m.bsphere.center, m.bsphere.radius);
  w.cidx(m.sections.length);
  for (const s of m.sections) w.i32(s.f0).u16(s.firstIndex).u16(s.firstVertex).u16(s.lastVertex).u16(s.u4).u16(s.numFaces);
  w.box(m.bbox2.min, m.bbox2.max, m.bbox2.valid);
  w.cidx(m.vertices.length);
  for (const v of m.vertices) { w.vec(v.pos); w.vec(v.normal); }
  w.i32(m.vertRevision);
  w.cidx(m.colors.length); for (const c of m.colors) w.u8(c[0]).u8(c[1]).u8(c[2]).u8(c[3]);
  w.i32(m.colorRevision);
  w.cidx(m.alphas.length); for (const c of m.alphas) w.u8(c[0]).u8(c[1]).u8(c[2]).u8(c[3]);
  w.i32(m.alphaRevision);
  w.cidx(m.uvStreams.length);
  for (const s of m.uvStreams) {
    w.cidx(s.uv.length); for (const t of s.uv) w.f32(t[0]).f32(t[1]);
    w.i32(s.a).i32(s.b);
  }
  w.cidx(m.indices.length); for (const i of m.indices) w.u16(i);
  w.i32(m.indexRevision);
  w.cidx(m.wireIndices.length); for (const i of m.wireIndices) w.u16(i);
  w.i32(m.wireRevision);

  w.cidx(m.kdopPad);
  w.cidx(m.kdopNodes.length);
  for (const n of m.kdopNodes) { w.vec(n.min); w.vec(n.max); w.i32(n.a).u16(n.b).u16(n.c); }
  w.cidx(m.kdopTris.length);
  for (const t of m.kdopTris) w.u16(t.v[0]).u16(t.v[1]).u16(t.v[2]).u16(t.mat);

  const rec = w.lazySkip();
  w.cidx(m.rawTriangles.length);
  for (const t of m.rawTriangles) {
    w.vec(t.v[0]); w.vec(t.v[1]); w.vec(t.v[2]);
    w.i32(t.numUV);
    for (const uv of t.uv) w.f32(uv[0]).f32(uv[1]);
    for (const c of t.col) w.u8(c[0]).u8(c[1]).u8(c[2]).u8(c[3]);
    w.i32(t.smoothing).i32(t.mat);
  }
  w.resolveLazy(rec);
  if (m.tail && m.tail.length) w.bytes(m.tail);
  return w;
}

// The 10-byte trailer every shipped mesh ends with. The first int is a version (11); the last four
// bytes are a per-mesh id that the shipped meshes vary and floortile leaves at zero.
const MESH_TRAILER = Buffer.from([0x0b, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const KDOP_LEAF = 5;              // triangles per leaf; matches what the shipped meshes carry

// Build the collision tree. Without it a static mesh is scenery you fall straight through, so this
// is what makes a converted map stand up. Semantics decoded from the shipped meshes:
//   internal node: bIsLeaf=0, b = left child, c = right child
//   leaf node:     bIsLeaf=1, b = triangle count, c = first triangle
// Leaves address a contiguous run of the emitted triangle array, so the triangles are written in
// tree order. b and c are 16-bit: at most 65535 triangles and 65535 nodes per mesh.
function buildKDOP(vertices, indices, triMaterial) {
  const n = indices.length / 3;
  const cx = new Float64Array(n), cy = new Float64Array(n), cz = new Float64Array(n);
  const lo = new Float64Array(n * 3), hi = new Float64Array(n * 3);
  for (let t = 0; t < n; t++) {
    const a = vertices[indices[t * 3]].pos, b = vertices[indices[t * 3 + 1]].pos, c = vertices[indices[t * 3 + 2]].pos;
    for (let k = 0; k < 3; k++) {
      lo[t * 3 + k] = Math.min(a[k], b[k], c[k]);
      hi[t * 3 + k] = Math.max(a[k], b[k], c[k]);
    }
    cx[t] = (a[0] + b[0] + c[0]) / 3; cy[t] = (a[1] + b[1] + c[1]) / 3; cz[t] = (a[2] + b[2] + c[2]) / 3;
  }
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const cent = [cx, cy, cz];
  const nodes = [];
  // Child links are 16-bit, so the tree must stay under 65536 nodes; fatter leaves buy the room.
  const leafSize = Math.max(KDOP_LEAF, Math.ceil(n / 25000));

  const build = (from, to) => {
    const self = nodes.length;
    nodes.push(null);
    const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
    for (let i = from; i < to; i++) {
      const t = order[i];
      for (let k = 0; k < 3; k++) {
        if (lo[t * 3 + k] < bmin[k]) bmin[k] = lo[t * 3 + k];
        if (hi[t * 3 + k] > bmax[k]) bmax[k] = hi[t * 3 + k];
      }
    }
    const count = to - from;
    if (count <= leafSize) { nodes[self] = { min: bmin, max: bmax, a: 1, b: count, c: from }; return self; }
    let axis = 0;
    for (let k = 1; k < 3; k++) if (bmax[k] - bmin[k] > bmax[axis] - bmin[axis]) axis = k;
    const slice = Array.prototype.slice.call(order.subarray(from, to));
    slice.sort((p, q) => cent[axis][p] - cent[axis][q]);
    order.set(slice, from);
    const mid = (from + to) >> 1;
    const l = build(from, mid), r = build(mid, to);
    nodes[self] = { min: bmin, max: bmax, a: 0, b: l, c: r };
    return self;
  };
  if (n > 0) build(0, n);

  const tris = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = order[i];
    tris[i] = { v: [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]], mat: triMaterial ? triMaterial[t] : 0 };
  }
  return { nodes, tris };
}

// Serialize geometry produced by build/mesh.js as a UStaticMesh.
function buildMeshExport(pkg, mesh) {
  const { Props, PropType } = require("./writer");
  const w = new (require("./writer").Writer)(1 << 20);

  // --- property block: Materials (one entry per section) + UseSimpleBoxCollision
  const pr = new Props(w, pkg.names);
  const inner = new (require("./writer").Writer)(1 << 12);
  inner.cidx(mesh.materials.length);
  for (const ref of mesh.materials) {
    const ip = new Props(inner, pkg.names);
    ip.bool("EnableCollision", true);
    ip.object("Material", ref);
    ip.end();
  }
  pr._tag("Materials", PropType.Array, Buffer.from(inner.out()));
  pr.bool("UseSimpleBoxCollision", false);
  // Without this the engine walks KInitActorKarma -> KCreateActorGeometry on every actor using the
  // mesh and allocates until it runs out of memory: there are no karma primitives to build from.
  pr.bool("UseSimpleKarmaCollision", false);
  pr.end();

  w.box(mesh.bbox.min, mesh.bbox.max, 1);
  w.sphere(mesh.center, mesh.radius);

  w.cidx(mesh.sections.length);
  for (const s of mesh.sections) {
    // The fourth WORD repeats the face count in every shipped mesh; leaving it zero is what made
    // the engine skip the mesh entirely (and crash outright once it did try to draw it).
    w.i32(0).u16(s.firstIndex).u16(s.firstVertex).u16(s.lastVertex).u16(s.numFaces).u16(s.numFaces);
  }
  w.box(mesh.bbox.min, mesh.bbox.max, 1);

  w.cidx(mesh.vertices.length);
  for (const v of mesh.vertices) { w.vec(v.pos); w.vec(v.normal); }
  w.i32(1);

  w.cidx(mesh.colors.length);
  for (const c of mesh.colors) w.u8(c[0]).u8(c[1]).u8(c[2]).u8(c[3]);
  w.i32(1);

  w.cidx(mesh.colors.length);                         // AlphaStream: one entry per vertex, as shipped
  for (let i = 0; i < mesh.colors.length; i++) w.u8(255).u8(255).u8(255).u8(255);
  w.i32(1);

  // A second UV stream carries the GoldSrc lightmap's own coordinates into an atlas, which the
  // material samples through TexCoordSource(SourceChannel=1). CoordIndex names the channel: 0 for
  // the texture, 1 for the light.
  const uvSets = mesh.lightPage !== undefined && mesh.uvs2 && mesh.uvs2.length === mesh.uvs.length ? 2 : 1;
  w.cidx(uvSets);
  w.cidx(mesh.uvs.length);
  for (const t of mesh.uvs) w.f32(t[0]).f32(t[1]);
  w.i32(0).i32(1);                                    // CoordIndex, Revision - in that order
  if (uvSets === 2) {
    w.cidx(mesh.uvs2.length);
    for (const t of mesh.uvs2) w.f32(t[0]).f32(t[1]);
    w.i32(1).i32(1);
  }

  w.cidx(mesh.indices.length);
  for (const i of mesh.indices) w.u16(i);
  w.i32(1);

  // IndexStream2 is the wireframe edge list KFEd draws in its orthographic viewports.
  const edges = new Set();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = mesh.indices[t + k], b = mesh.indices[t + (k + 1) % 3];
      edges.add(a < b ? a * 65536 + b : b * 65536 + a);
    }
  }
  w.cidx(edges.size * 2);
  for (const e of edges) w.u16(Math.floor(e / 65536)).u16(e % 65536);
  w.i32(1);

  // kDOP collision tree - without it the player falls through the world.
  const triMat = new Int32Array(mesh.indices.length / 3);
  for (let si = 0; si < mesh.sections.length; si++) {
    const s = mesh.sections[si];
    for (let f = 0; f < s.numFaces; f++) triMat[s.firstIndex / 3 + f] = si;
  }
  const kdop = buildKDOP(mesh.vertices, mesh.indices, triMat);
  w.cidx(0);
  w.cidx(kdop.nodes.length);
  for (const n of kdop.nodes) { w.vec(n.min); w.vec(n.max); w.i32(n.a).u16(n.b).u16(n.c); }
  w.cidx(kdop.tris.length);
  for (const t of kdop.tris) w.u16(t.v[0]).u16(t.v[1]).u16(t.v[2]).u16(t.mat);

  // RawTriangles: what KFEd displays and rebuilds from, so it must mirror the index stream.
  const rec = w.lazySkip();
  w.cidx(mesh.indices.length / 3);
  for (const s of mesh.sections) {
    for (let f = 0; f < s.numFaces; f++) {
      const base = s.firstIndex + f * 3;
      for (let k = 0; k < 3; k++) w.vec(mesh.vertices[mesh.indices[base + k]].pos);
      // The UV-set count here has to match the streams above, or KFEd rebuilds the mesh from
      // triangles that disagree with it and the second channel is lost the first time it is opened.
      w.i32(uvSets);
      for (let k = 0; k < 3; k++) { const uv = mesh.uvs[mesh.indices[base + k]]; w.f32(uv[0]).f32(uv[1]); }
      if (uvSets === 2) {
        for (let k = 0; k < 3; k++) { const uv = mesh.uvs2[mesh.indices[base + k]]; w.f32(uv[0]).f32(uv[1]); }
      }
      for (let k = 0; k < 3; k++) { const c = mesh.colors[mesh.indices[base + k]]; w.u8(c[0]).u8(c[1]).u8(c[2]).u8(c[3]); }
      w.i32(0).i32(mesh.sections.indexOf(s));
    }
  }
  w.resolveLazy(rec);
  w.bytes(MESH_TRAILER);
  return w;
}

// UStaticMeshInstance: the per-actor baked lighting for a static mesh. KF stores one colour per
// mesh vertex; the five trailing bytes are what the smallest shipped instance ends with (the
// larger ones carry per-light shadow lists after them, which nothing requires).
function buildMeshInstance(pkg, mesh) {
  const w = new Writer(mesh.colors.length * 4 + 16);
  w.cidx(pkg.names.none);                       // empty property block
  w.cidx(mesh.colors.length);
  for (const c of mesh.colors) w.u8(c[0]).u8(c[1]).u8(c[2]).u8(c[3]);
  w.bytes(Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00]));
  return w;
}

module.exports = { readMesh, writeMesh, buildMeshExport, buildMeshInstance, MESH_TRAILER };
