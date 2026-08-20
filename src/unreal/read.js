// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Reader for UE2.5 (v128/29) packages and the full world UModel, including the trailer that holds
// the baked BSP lighting. Used to verify what this tool writes, and to study the shipped maps.
"use strict";

const fs = require("fs");

const RF_LoadForServer = 0x00020000;

class Rd {
  constructor(buf, pos) { this.b = buf; this.pos = pos | 0; }
  u8() { return this.b[this.pos++]; }
  i16() { const v = this.b.readInt16LE(this.pos); this.pos += 2; return v; }
  u16() { const v = this.b.readUInt16LE(this.pos); this.pos += 2; return v; }
  i32() { const v = this.b.readInt32LE(this.pos); this.pos += 4; return v; }
  u32() { const v = this.b.readUInt32LE(this.pos); this.pos += 4; return v; }
  f32() { const v = this.b.readFloatLE(this.pos); this.pos += 4; return v; }
  skip(n) { this.pos += n; return this; }
  vec() { return [this.f32(), this.f32(), this.f32()]; }
  cidx() {
    let b = this.b[this.pos++]; const neg = (b & 0x80) !== 0; let v = b & 0x3f;
    if (b & 0x40) { let sh = 6; for (; ;) { b = this.b[this.pos++]; v |= (b & 0x7f) << sh; sh += 7; if (!(b & 0x80)) break; } }
    return neg ? -v : v;
  }
  fstring() { const n = this.cidx(); if (n <= 0) return ""; const s = this.b.toString("latin1", this.pos, this.pos + n - 1); this.pos += n; return s; }
  array(fn) { const n = this.cidx(); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = fn(this); return a; }
}

function parsePackage(buf) {
  const r = new Rd(buf, 0);
  const tag = r.u32(), fileVersion = r.u16(), licenseeVersion = r.u16(), packageFlags = r.u32();
  const nameCount = r.u32(), nameOffset = r.u32();
  const exportCount = r.u32(), exportOffset = r.u32();
  const importCount = r.u32(), importOffset = r.u32();
  // Unreal Engine 1 wrote a heritage list where 68 and later write a GUID and generations. Three of
  // Tactical Ops' texture packages are still version 61, and reading their two heritage words as a
  // generation count runs the walk off the end of the file.
  let guid = null;
  const generations = [];
  if (fileVersion < 68) {
    r.u32(); r.u32();                                     // heritageCount, heritageOffset
  } else {
    guid = buf.subarray(r.pos, r.pos + 16); r.skip(16);
    const genCount = r.u32();
    for (let i = 0; i < genCount; i++) generations.push({ exportCount: r.u32(), nameCount: r.u32() });
  }

  r.pos = nameOffset;
  const names = [];
  for (let i = 0; i < nameCount; i++) {
    if (fileVersion < 64) {                               // a bare C string, no length in front of it
      const z = buf.indexOf(0, r.pos);
      names.push(buf.toString("latin1", r.pos, z));
      r.pos = z + 1;
    } else {
      const n = r.cidx();
      names.push(buf.toString("latin1", r.pos, r.pos + n - 1));
      r.pos += n;
    }
    r.u32();                                              // name flags
  }

  r.pos = importOffset;
  const imports = [];
  for (let i = 0; i < importCount; i++) {
    imports.push({ classPackage: names[r.cidx()], className: names[r.cidx()], packageIndex: r.i32(), name: names[r.cidx()] });
  }

  r.pos = exportOffset;
  const exports_ = [];
  for (let i = 0; i < exportCount; i++) {
    const classIndex = r.cidx(), superIndex = r.cidx(), packageIndex = r.i32();
    const objectName = r.cidx(), objectFlags = r.u32(), serialSize = r.cidx();
    const serialOffset = serialSize > 0 ? r.cidx() : 0;
    exports_.push({ classIndex, superIndex, packageIndex, name: names[objectName], objectFlags, serialSize, serialOffset });
  }

  const refName = (ref) => ref < 0 ? (imports[-ref - 1] || {}).name : ref > 0 ? (exports_[ref - 1] || {}).name : "None";
  const classOf = (e) => refName(e.classIndex);
  return { buf, header: { tag, fileVersion, licenseeVersion, packageFlags, guid, generations }, names, imports, exports: exports_, refName, classOf };
}

function findWorldModel(pkg) {
  const models = pkg.exports
    .filter((e) => pkg.classOf(e) === "Model" && (e.objectFlags & RF_LoadForServer) && e.serialSize > 0);
  // By name first. "Largest wins" is right for a shipped map, but this converter's world model is
  // deliberately one node, so a water volume's box brush outgrew it and the verifier started
  // checking a Volume against the world's invariants.
  return models.find((e) => e.name === "WorldModel") ||
    models.sort((a, b) => b.serialSize - a.serialSize)[0] || null;
}

// Full UModel including the trailer. Throws unless the walk lands exactly on serialOffset+serialSize.
function readModel(pkg, exp) {
  const r = new Rd(pkg.buf, exp.serialOffset);
  const end = exp.serialOffset + exp.serialSize;
  r.skip(1);                                              // property block: just "None"
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
    const sphere = { center: x.vec(), radius: x.f32() };
    const iZone = [x.u8(), x.u8()];
    const numVertices = x.u8();
    const iLeaf = [x.i32(), x.i32()];
    const iSection = x.i32(), iFirstVertex = x.i32(), iLightMap = x.i32();
    return { plane, zoneMask, nodeFlags, iVertPool, iSurf, iBack, iFront, iPlane, iCollisionBound, iRenderBound, sphere, iZone, numVertices, iLeaf, iSection, iFirstVertex, iLightMap };
  });
  const surfs = r.array((x) => ({
    material: x.cidx(), polyFlags: x.u32(),
    pBase: x.cidx(), vNormal: x.cidx(), vTextureU: x.cidx(), vTextureV: x.cidx(),
    iLightMap: x.cidx(), actor: x.cidx(),
    plane: [x.f32(), x.f32(), x.f32(), x.f32()], lightMapScale: x.f32(),
  }));
  const verts = r.array((x) => ({ pVertex: x.cidx(), iSide: x.cidx() }));
  const numSharedSides = r.i32();
  const numZones = r.i32();
  const zones = [];
  for (let i = 0; i < numZones; i++) {
    zones.push({ zoneActor: r.cidx(), connectivity: [r.u32(), r.u32()], visibility: [r.u32(), r.u32()], lastRenderTime: r.f32() });
  }
  const polys = r.cidx();
  const bounds = r.array((x) => ({ min: x.vec(), max: x.vec(), valid: x.u8() }));
  const leafHulls = r.array((x) => x.i32());
  const leaves = r.array((x) => ({ iZone: x.cidx(), iPermeating: x.cidx(), iVolumetric: x.cidx(), visibleZones: [x.u32(), x.u32()] }));
  const lights = r.array((x) => x.cidx());
  const rootOutside = r.i32(), linked = r.i32();
  const sections = r.array((x) => {
    const vertices = x.array((y) => ({
      pos: y.vec(), u: y.f32(), v: y.f32(), u2: y.f32(), v2: y.f32(), normal: y.vec(),
    }));
    const revision = x.i32();
    return { vertices, revision, material: x.cidx(), numNodes: x.i32(), polyFlags: x.u32(), iLightMapTexture: x.i32() };
  });
  const lightMaps = r.array((x) => {
    const iTexture = x.cidx(), iSurf = x.cidx(), iZone = x.cidx();
    const offsetX = x.cidx(), offsetY = x.cidx(), sizeX = x.cidx(), sizeY = x.cidx();
    const worldToLightMap = []; for (let i = 0; i < 16; i++) worldToLightMap.push(x.f32());
    const base = x.vec(), xAxis = x.vec(), yAxis = x.vec();
    const bitmaps = x.array((y) => {
      const lightActor = y.cidx();
      const nb = y.cidx(); const at = y.pos; y.skip(nb);
      return { lightActor, bits: pkg.buf.subarray(at, at + nb), sizeX: y.i32(), sizeY: y.i32(), stride: y.i32(), minX: y.i32(), minY: y.i32(), maxX: y.i32(), maxY: y.i32() };
    });
    return { iTexture, iSurf, iZone, offsetX, offsetY, sizeX, sizeY, worldToLightMap, base, xAxis, yAxis, bitmaps, level: x.cidx(), revision: x.i32() };
  });
  const lightMapTextures = r.array((x) => {
    const level = x.cidx();
    const lm = x.array((y) => y.i32());
    const cacheId = [x.u32(), x.u32()];
    const revision = x.i32();
    const mips = [];
    for (let m = 0; m < 2; m++) { x.i32(); const n = x.cidx(); const at = x.pos; x.skip(n); mips.push(pkg.buf.subarray(at, at + n)); }
    return { level, lightMaps: lm, cacheId, revision, mips, format: x.u8(), width: x.i32(), height: x.i32(), texRevision: x.i32() };
  });
  if (r.pos !== end) throw new Error("UModel walk ended at " + r.pos + ", expected " + end + " (off by " + (r.pos - end) + ")");
  return { bbox, bsphere, vectors, points, nodes, surfs, verts, numSharedSides, zones, polys, bounds, leafHulls, leaves, lights, rootOutside, linked, sections, lightMaps, lightMapTextures };
}

function load(file) { return parsePackage(fs.readFileSync(file)); }

module.exports = { parsePackage, findWorldModel, readModel, load, Rd };
