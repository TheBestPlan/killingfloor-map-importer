// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// The Unreal Engine 1 UModel, as Unreal Tournament 99 (file version 69) writes it.
//
// Same object Killing Floor stores three engine versions later, and the differences are all in the
// tail: UE1 has no per-node bounding sphere, no render Sections, and its baked light is a list of
// per-surface light meshes plus one bit per luxel per light in `LightBits` - not the finished DXT
// atlases of v128 (see ../unreal/read.js for that side).
//
// Field order is Epic's own, from UnModel.cpp and UnObj.h of the UT99 v400 source drop. The oracle
// is the same one the v128 reader uses: the walk has to land exactly on serialOffset + serialSize,
// which it does on all 36 stock Tactical Ops maps.
"use strict";

const { Rd } = require("../unreal/read");

// EPolyFlags, the ones a converter has to act on.
const PF = {
  Invisible: 0x00000001,
  Masked: 0x00000002,
  Translucent: 0x00000004,
  NotSolid: 0x00000008,
  Environment: 0x00000010,
  Semisolid: 0x00000020,
  Modulated: 0x00000040,
  FakeBackdrop: 0x00000080,
  TwoSided: 0x00000100,
  AutoUPan: 0x00000200,
  AutoVPan: 0x00000400,
  NoSmooth: 0x00000800,
  SmallWavy: 0x00002000,
  Unlit: 0x00400000,
  Portal: 0x04000000,
  Mirrored: 0x08000000,
};

// A world model is the biggest one in the file by a wide margin - every brush actor owns a model of
// its own, and a map has hundreds of those.
function findWorldModel(pkg) {
  const models = pkg.exports.filter((e) => pkg.classOf(e) === "Model" && e.serialSize > 0);
  return models.sort((a, b) => b.serialSize - a.serialSize)[0] || null;
}

const RF_HasStack = 0x02000000;

function readModel(pkg, exp) {
  const r = new Rd(pkg.buf, exp.serialOffset);
  const end = exp.serialOffset + exp.serialSize;
  // 71 of the 400 mover brushes in the stock maps carry RF_HasStack, and a UObject with it writes
  // its script state frame before anything else - five fields, the last only when the node is set.
  if (exp.objectFlags & RF_HasStack) {
    const node = r.cidx(); r.cidx(); r.i32(); r.i32(); r.i32();
    if (node !== 0) r.cidx();
  }
  r.cidx();                                               // property block: "None"
  const bbox = { min: r.vec(), max: r.vec(), valid: r.u8() };
  const bsphere = { center: r.vec(), radius: r.f32() };
  const vectors = r.array((x) => x.vec());
  const points = r.array((x) => x.vec());
  const nodes = r.array((x) => {
    const plane = [x.f32(), x.f32(), x.f32(), x.f32()];
    const zoneMask = [x.u32(), x.u32()];
    const nodeFlags = x.u8();
    const iVertPool = x.cidx(), iSurf = x.cidx();
    const iBack = x.cidx(), iFront = x.cidx(), iPlane = x.cidx();
    const iCollisionBound = x.cidx(), iRenderBound = x.cidx();
    const iZone = [x.u8(), x.u8()];
    const numVertices = x.u8();
    const iLeaf = [x.i32(), x.i32()];
    return { plane, zoneMask, nodeFlags, iVertPool, iSurf, iBack, iFront, iPlane, iCollisionBound, iRenderBound, iZone, numVertices, iLeaf };
  });
  const surfs = r.array((x) => ({
    material: x.cidx(), polyFlags: x.u32(),
    pBase: x.cidx(), vNormal: x.cidx(), vTextureU: x.cidx(), vTextureV: x.cidx(),
    iLightMap: x.cidx(), iBrushPoly: x.cidx(),
    panU: x.i16(), panV: x.i16(),
    actor: x.cidx(),
  }));
  const verts = r.array((x) => ({ pVertex: x.cidx(), iSide: x.cidx() }));
  const numSharedSides = r.i32();
  const numZones = r.i32();
  const zones = [];
  // No LastRenderTime here: UE1's FZoneProperties serializer returns before writing it.
  for (let i = 0; i < numZones; i++) {
    zones.push({ zoneActor: r.cidx(), connectivity: [r.u32(), r.u32()], visibility: [r.u32(), r.u32()] });
  }
  const polys = r.cidx();
  const lightMap = r.array((x) => ({
    dataOffset: x.i32(), pan: x.vec(),
    uClamp: x.cidx(), vClamp: x.cidx(),
    uScale: x.f32(), vScale: x.f32(),
    iLightActors: x.i32(),
  }));
  const nBits = r.cidx();
  const lightBits = pkg.buf.subarray(r.pos, r.pos + nBits); r.skip(nBits);
  const bounds = r.array((x) => ({ min: x.vec(), max: x.vec(), valid: x.u8() }));
  const leafHulls = r.array((x) => x.i32());
  const leaves = r.array((x) => ({ iZone: x.cidx(), iPermeating: x.cidx(), iVolumetric: x.cidx(), visibleZones: [x.u32(), x.u32()] }));
  // One entry per light reaching one surface; FLightMapIndex.iLightActors indexes into this and the
  // run ends at the first 0.
  const lights = r.array((x) => x.cidx());
  const rootOutside = r.i32(), linked = r.i32();
  if (r.pos !== end) throw new Error("UE1 UModel walk ended at " + r.pos + ", expected " + end + " (off by " + (r.pos - end) + ")");
  return {
    bbox, bsphere, vectors, points, nodes, surfs, verts, numSharedSides, numZones, zones,
    polys, lightMap, lightBits, bounds, leafHulls, leaves, lights, rootOutside, linked,
  };
}

// UPolys: the CSG source polygons of a brush. The world's are of no use - the BSP already holds the
// result - but a Mover's are the only copy of its geometry, since a mover is not part of the BSP.
//
// UPolys::Serialize writes the element count TWICE (Num and Max) before the elements, and FPoly is
// Epic's own order from UnModel.cpp.
function readPolys(pkg, exp) {
  const r = new Rd(pkg.buf, exp.serialOffset);
  const end = exp.serialOffset + exp.serialSize;
  if (exp.objectFlags & RF_HasStack) {
    const node = r.cidx(); r.cidx(); r.i32(); r.i32(); r.i32();
    if (node !== 0) r.cidx();
  }
  r.cidx();                                               // property block: "None"
  const num = r.i32(); r.i32();                           // Num, Max
  if (num < 0 || num > 65536) throw new Error(exp.name + ": " + num + " polygons is not a UPolys");
  const polys = [];
  for (let i = 0; i < num; i++) {
    const n = r.cidx();
    const base = r.vec(), normal = r.vec(), textureU = r.vec(), textureV = r.vec();
    const vertices = [];
    for (let v = 0; v < n; v++) vertices.push(r.vec());
    const polyFlags = r.u32();
    const actor = r.cidx(), texture = r.cidx();
    const itemName = pkg.names[r.cidx()];
    const iLink = r.cidx(), iBrushPoly = r.cidx();
    const panU = r.i16(), panV = r.i16();
    polys.push({ base, normal, textureU, textureV, vertices, polyFlags, actor, texture, itemName, iLink, iBrushPoly, panU, panV });
  }
  if (r.pos !== end) throw new Error("UPolys walk ended at " + r.pos + ", expected " + end);
  return polys;
}

// The ring of world-space points a node draws, in the node's own winding.
function nodePoints(model, node) {
  const out = [];
  for (let i = 0; i < node.numVertices; i++) {
    const v = model.verts[node.iVertPool + i];
    if (!v) return [];
    const p = model.points[v.pVertex];
    if (!p) return [];
    out.push(p);
  }
  return out;
}

// Is this point inside solid rock? Descends the BSP the way the engine's own PointRegion does: at
// each node take the side the point falls on, and a side with no child and no leaf is solid.
function inSolid(model, p) {
  if (!model.nodes.length) return false;
  let i = 0;
  for (let guard = 0; guard < 1024; guard++) {
    const n = model.nodes[i];
    if (!n) return false;
    const front = n.plane[0] * p[0] + n.plane[1] * p[1] + n.plane[2] * p[2] - n.plane[3] >= 0;
    const child = front ? n.iFront : n.iBack;
    if (child < 0) return (front ? n.iLeaf[1] : n.iLeaf[0]) < 0;
    i = child;
  }
  return false;
}

// The highest floor under a point, or null when there is none within `maxDrop`.
//
// A Tactical Ops PlayerStart sits with the pawn's feet on the ground - measured over TO-Crossfire's
// 32 starts, the drop from the start to the floor under it is 33 to 42 units against the pawn's own
// half-height of 39 - so the two games' pawn heights could be trusted to line up. Tracing the floor
// instead costs one pass over the nodes and stands the spawn on what is actually there.
function floorUnder(model, p, maxDrop) {
  let best = -Infinity;
  for (const node of model.nodes) {
    if (node.numVertices < 3 || node.plane[2] < 0.7) continue;
    const ring = nodePoints(model, node);
    if (ring.length < 3) continue;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if (((a[1] > p[1]) !== (b[1] > p[1])) &&
        (p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0])) inside = !inside;
    }
    if (!inside) continue;
    const z = (node.plane[3] - node.plane[0] * p[0] - node.plane[1] * p[1]) / node.plane[2];
    if (z <= p[2] + 1 && z > best && z > p[2] - maxDrop) best = z;
  }
  return best > -Infinity ? best : null;
}

module.exports = { readModel, readPolys, findWorldModel, nodePoints, floorUnder, inSolid, PF };
