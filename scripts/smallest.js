// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Find the map with the smallest world-Model trailer (= easiest to decode by hand),
// and report how many trailer bytes each map carries per BSP surface (lighting density).
const fs = require("fs");
const path = require("path");
const KFRom = require("./_kfrom");

function trailerInfo(file) {
  const u8 = new Uint8Array(fs.readFileSync(file));
  const pkg = KFRom.parsePackage(u8);
  const exp = KFRom.findWorldModel(pkg);
  if (!exp) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let pos = exp.serialOffset + 1 + 25 + 16;
  const cidx = () => {
    let b = u8[pos++]; const neg = (b & 0x80) !== 0; let val = b & 0x3f;
    if (b & 0x40) { let sh = 6; for (; ;) { b = u8[pos++]; val |= (b & 0x7f) << sh; sh += 7; if (!(b & 0x80)) break; } }
    return neg ? -val : val;
  };
  const nVec = cidx(); pos += nVec * 12;
  const nPts = cidx(); pos += nPts * 12;
  const nNodes = cidx();
  for (let i = 0; i < nNodes; i++) { pos += 25; cidx(); cidx(); cidx(); cidx(); cidx(); cidx(); cidx(); pos += 16 + 3 + 8 + 12; }
  const nSurfs = cidx();
  for (let i = 0; i < nSurfs; i++) { cidx(); pos += 4; cidx(); cidx(); cidx(); cidx(); cidx(); cidx(); pos += 20; }
  const nVerts = cidx();
  for (let i = 0; i < nVerts; i++) { cidx(); cidx(); }
  const end = exp.serialOffset + exp.serialSize;
  return { file: path.basename(file), nNodes, nSurfs, nVerts, geom: pos - exp.serialOffset, trailer: end - pos, start: pos, end };
}

const dirs = process.argv.slice(2);
const rows = [];
for (const d of dirs) {
  for (const f of fs.readdirSync(d)) {
    if (!f.toLowerCase().endsWith(".rom")) continue;
    try { const t = trailerInfo(path.join(d, f)); if (t) rows.push(t); } catch (e) { }
  }
}
rows.sort((a, b) => a.trailer - b.trailer);
console.log("trailer(KB)  geom(KB)  surfs  nodes   B/surf   map");
for (const t of rows.slice(0, 12))
  console.log(String((t.trailer / 1024).toFixed(1)).padStart(10) + String((t.geom / 1024).toFixed(0)).padStart(10) +
    String(t.nSurfs).padStart(7) + String(t.nNodes).padStart(7) + String(Math.round(t.trailer / Math.max(1, t.nSurfs))).padStart(9) + "   " + t.file);
console.log("...");
for (const t of rows.slice(-4))
  console.log(String((t.trailer / 1024).toFixed(1)).padStart(10) + String((t.geom / 1024).toFixed(0)).padStart(10) +
    String(t.nSurfs).padStart(7) + String(t.nNodes).padStart(7) + String(Math.round(t.trailer / Math.max(1, t.nSurfs))).padStart(9) + "   " + t.file);
console.log("\nmaps scanned: " + rows.length);
const smallest = rows[0];
console.log("SMALLEST trailer: " + smallest.file + "  bytes " + smallest.trailer + " at " + smallest.start + ".." + smallest.end);
