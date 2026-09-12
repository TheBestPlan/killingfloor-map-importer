// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Vampire: The Masquerade - Redemption `.nil` level reader (Nihilistic "Nod" engine, NIL v27).
//
// A `.nil` (magic `NIL\x10`, version 27 at 0x04) is a numeric Nod scene graph. Header (0x60): material-
// name count at 0x5C, then that many 0x20-byte shader names. The world is stored per sector as split arrays.
// The sector skeleton (below) matches the official Nihilistic NodSDK `nil.htm` spec, but that spec is
// truncated right at aSectorVertices - the wedge fields and the triangle order were reverse-engineered from
// the game's own l1_brot / v1_nrth and verified byte-for-byte:
//   aVertices[]     - NumVertices (u16) then that many float3 LE positions (12 bytes each).
//   cSectorVertex[] - NumSectorVerts (u16) then that many 24-byte wedges:
//                       u16 posIndex @0  (into aVertices)
//                       u16 flags/lightmap-page @2  (constant per sector)
//                       u8[3] RGB @4, u8 alpha @7 (== 0xFF, the reliable record marker)
//                       f32 texU @8, f32 texV @12  (world-space planar UV)
//                       f32 lmU @16, f32 lmV @20   (lightmap UV)
//                     The wedges are one Direct3D triangle STRIP: consecutive triples index aVertices, and a
//                     repeated index (degenerate triangle) restarts the strip between surfaces. Rebuilding
//                     that strip reproduces the exact geometry - every sector >=95% vertex-covered with zero
//                     cross-surface edges (the old 6-byte-misaligned parse paired each wedge's UV with the
//                     next wedge's position, which is what left the holes and crooked textures).
//   post-wedge block - the per-sector BSP tree, used only for collision (all -1 child links); not geometry.
//
// The exact per-face material list is not in the public spec; each sector carries one base material index
// (the @2 field), so surfaces are textured by that plus triangle orientation (see convert.js). Textures live
// in the game's LMaterials.nob; material `London\SBIwall1_2_L` maps to `materials/london/sbiwall1_2_l.tga`.
// See docs/games/vtmr.md.
"use strict";

const CSV = 24;          // cSectorVertex (wedge) stride
const EDGE_CAP = 6000;   // absolute safety cap: a strip edge longer than this is a stray restart, not a surface

function readHeader(buf) {
  if (buf.toString("latin1", 0, 3) !== "NIL") throw new Error("not a Nod .nil (bad magic)");
  const matCount = buf.readUInt32LE(0x5c);
  if (matCount > 4096) throw new Error("implausible material count " + matCount);
  const materials = [];
  for (let i = 0; i < matCount; i++) materials.push(buf.toString("latin1", 0x60 + i * 32, 0x60 + i * 32 + 32).replace(/\0.*$/, ""));
  return { materials, matCount, dataStart: 0x60 + matCount * 32 };
}

// A cSectorVertex wedge: alpha byte == 0xFF at +7 (the constant marker), a small posIndex (u16 @0), and four
// finite UV floats in their observed ranges. This is the true 24-byte record boundary.
function isWedge(buf, o) {
  if (o + CSV > buf.length) return false;
  if (buf[o + 7] !== 0xff) return false;
  if (buf.readUInt16LE(o) > 8000) return false;
  const tu = buf.readFloatLE(o + 8), tv = buf.readFloatLE(o + 12), lu = buf.readFloatLE(o + 16), lv = buf.readFloatLE(o + 20);
  if (![tu, tv, lu, lv].every(Number.isFinite)) return false;
  if (Math.abs(tu) > 5000 || Math.abs(tv) > 5000) return false;
  if (lu < -4 || lu > 5 || lv < -4 || lv > 5) return false;
  return true;
}
function isPos(buf, o) {
  if (o < 0 || o + 12 > buf.length) return false;
  const x = buf.readFloatLE(o), y = buf.readFloatLE(o + 4), z = buf.readFloatLE(o + 8);
  return [x, y, z].every(Number.isFinite) && Math.abs(x) < 1e5 && Math.abs(y) < 1e5 && Math.abs(z) < 1e5;
}

// Each sector: [... aVertices ...][NumSectorVerts u16][cSectorVertex[]]. Anchor on the wedge run (0xFF
// markers), require NumSectorVerts (u16 just before it) to equal the run length, then recover NumVertices
// (u16 just before aVertices) so aVertices lands exactly. Verified 115/115 (l1_brot), 56/56 (v1_nrth).
function findSectors(buf, dataStart) {
  const sectors = [];
  let p = dataStart;
  while (p < buf.length - CSV) {
    if (!isWedge(buf, p)) { p++; continue; }
    let e = p; while (isWedge(buf, e)) e += CSV;
    const n = (e - p) / CSV;
    if (n >= 4 && buf.readUInt16LE(p - 2) === n) {
      let maxIdx = 0; for (let r = 0; r < n; r++) maxIdx = Math.max(maxIdx, buf.readUInt16LE(p + r * CSV));
      let numPos = -1;
      for (let cand = maxIdx + 1; cand <= maxIdx + 400; cand++) {
        const aStart = p - 2 - cand * 12;
        if (aStart < dataStart) break;
        if (buf.readUInt16LE(aStart - 2) === cand && isPos(buf, aStart)) { numPos = cand; break; }
      }
      if (numPos < 0) numPos = maxIdx + 1;                   // fallback: still land aVertices via the count
      const aStart = p - 2 - numPos * 12;
      if (aStart >= dataStart && isPos(buf, aStart)) sectors.push({ aStart, numPos, wStart: p, numCsv: n });
    }
    p = e;
  }
  return sectors;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// One sector -> { pos, uv, surfaces:[{ mat, tris }], matSet }. pos/uv are indexed by WEDGE (each wedge is a
// position + its UV), tris hold wedge indices - the contract convert.js consumes. The wedges are a triangle
// strip; rebuild it, restarting on a degenerate triple (repeated position index) or a stray long edge.
function sectorMesh(buf, sec) {
  const pos = [], uv = [], pidx = [];
  for (let r = 0; r < sec.numCsv; r++) {
    const o = sec.wStart + r * CSV, pi = buf.readUInt16LE(o), po = sec.aStart + pi * 12;
    pidx.push(pi);
    pos.push([buf.readFloatLE(po), buf.readFloatLE(po + 4), buf.readFloatLE(po + 8)]);
    uv.push([buf.readFloatLE(o + 8), buf.readFloatLE(o + 12)]);
  }
  const tris = [];
  let parity = 0;
  for (let k = 0; k + 2 < sec.numCsv; k++) {
    const a = pidx[k], b = pidx[k + 1], c = pidx[k + 2];
    if (a === b || b === c || a === c) { parity = 0; continue; }              // degenerate = strip restart
    const A = pos[k], B = pos[k + 1], C = pos[k + 2];
    if (!A.every(Number.isFinite) || !B.every(Number.isFinite) || !C.every(Number.isFinite)) { parity = 0; continue; }
    if (Math.max(dist(A, B), dist(B, C), dist(A, C)) > EDGE_CAP) { parity = 0; continue; }
    tris.push(parity % 2 ? [k, k + 2, k + 1] : [k, k + 1, k + 2]);
    parity++;
  }
  // The sector's base material (@2 in every wedge; constant per sector) plus the header material palette:
  // convert.js textures each surface by orientation, preferring a same-type material from this set.
  const base = buf.readUInt16LE(sec.wStart + 2);
  const matSet = [base];
  return { pos, uv, surfaces: tris.length ? [{ mat: -1, tris }] : [], matSet };
}

function readNil(buf) {
  const { materials, dataStart } = readHeader(buf);
  const meshes = [];
  let tris = 0;
  for (const sec of findSectors(buf, dataStart)) {
    const m = sectorMesh(buf, sec);
    if (m.surfaces.length) { for (const s of m.surfaces) tris += s.tris.length; meshes.push(m); }
  }
  return { materials, meshes, triangles: tris, texturedTriangles: 0 };
}

module.exports = { readNil, readHeader, findSectors, sectorMesh };

// Self-check: a synthetic sector - 4 quad-corner positions and a 6-wedge stream that is two triangles
// with a degenerate restart between them (0,1,2 | 2,1 dropped | 3). Must rebuild exactly 2 triangles,
// one from each side of the restart, with pos/uv indexed by wedge.
if (require.main === module) {
  const buf = Buffer.alloc(48 + 6 * CSV);
  const P = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [10, 10, 0]];
  P.forEach((p, i) => { buf.writeFloatLE(p[0], i * 12); buf.writeFloatLE(p[1], i * 12 + 4); buf.writeFloatLE(p[2], i * 12 + 8); });
  const strip = [0, 1, 2, 2, 1, 3];                    // triples (2,2,1) and (2,1,3-index2) are degenerate -> restart
  strip.forEach((pi, r) => { const o = 48 + r * CSV; buf.writeUInt16LE(pi, o); buf[o + 7] = 0xff; buf.writeFloatLE(0.1 * r, o + 8); buf.writeFloatLE(0.2 * r, o + 12); });
  const m = sectorMesh(buf, { aStart: 0, numPos: 4, wStart: 48, numCsv: 6 });
  const assert = (c, msg) => { if (!c) throw new Error("nil self-check: " + msg); };
  const tris = m.surfaces[0].tris;
  assert(tris.length === 2, "expected 2 triangles (one per strip side), got " + tris.length);
  assert(m.pos.length === 6 && m.uv.length === 6, "pos/uv indexed by wedge");
  assert(tris.every((t) => t.every((w) => w >= 0 && w < 6)), "wedge indices in range");
  assert(m.pos[5][0] === 10 && m.pos[5][1] === 10, "wedge 5 resolves position index 3 -> (10,10)");
  console.log("nil.js: strip reconstruction OK (" + tris.length + " tris, restart honoured)");
}
