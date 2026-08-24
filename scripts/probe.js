// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// What actually fills the UModel trailer? Probe byte statistics + samples across the range.
const fs = require("fs");
const KFRom = require("./_kfrom");

const file = process.argv[2];
const u8 = new Uint8Array(fs.readFileSync(file));
const pkg = KFRom.parsePackage(u8);
const exp = KFRom.findWorldModel(pkg);
const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
let pos = exp.serialOffset + 1 + 25 + 16;
const cidx = () => { let b = u8[pos++]; const neg = (b & 0x80) !== 0; let val = b & 0x3f; if (b & 0x40) { let sh = 6; for (; ;) { b = u8[pos++]; val |= (b & 0x7f) << sh; sh += 7; if (!(b & 0x80)) break; } } return neg ? -val : val; };
let n = cidx(); pos += n * 12;
n = cidx(); pos += n * 12;
n = cidx(); for (let i = 0; i < n; i++) { pos += 25; for (let k = 0; k < 7; k++) cidx(); pos += 16 + 3 + 8 + 12; }
n = cidx(); for (let i = 0; i < n; i++) { cidx(); pos += 4; for (let k = 0; k < 6; k++) cidx(); pos += 20; }
n = cidx(); for (let i = 0; i < n; i++) { cidx(); cidx(); }
const t0 = pos, end = exp.serialOffset + exp.serialSize, len = end - t0;
console.log(file.split(/[\\/]/).pop() + "  trailer " + len + " bytes @" + t0);

// byte histogram
const h = new Uint32Array(256);
for (let i = t0; i < end; i++) h[u8[i]]++;
const topB = [...h.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log("byte histogram top: " + topB.map(([b, c]) => "0x" + b.toString(16).padStart(2, "0") + ":" + (100 * c / len).toFixed(1) + "%").join("  "));

// samples
for (const frac of [0.001, 0.02, 0.1, 0.25, 0.5, 0.75, 0.95, 0.999]) {
  const at = t0 + Math.floor(len * frac);
  let s = "";
  for (let i = 0; i < 32; i++) s += u8[at + i].toString(16).padStart(2, "0") + " ";
  console.log("  @" + (100 * frac).toFixed(1).padStart(5) + "%  " + s);
}

// how far does the repeating FBox run at t0+52?
const fboxAt = (p) => Array.from({ length: 6 }, (_, i) => dv.getFloat32(p + i * 4, true));
const first = fboxAt(t0 + 52).join(",");
let reps = 0;
for (let p = t0 + 52; p + 25 <= end; p += 25) { if (fboxAt(p).join(",") !== first || u8[p + 24] !== 1) break; reps++; }
console.log("identical FBox repeats from +52: " + reps + " (=" + reps * 25 + " bytes)  box " + first);
