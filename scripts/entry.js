// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Decode the UModel trailer on the smallest possible case: Entry.rom = 6 surfs, 6 nodes.
// Hypothesis: trailer = NumSharedSides + Polys + LightMap[FLightMapIndex] + LightBits(1 bit/luxel/light)
// + Bounds + LeafHulls + Leaves + Lights + RootOutside/Linked + NumZones + Zones.
// Test: predicted LightBits bytes from surface area / ShadowMapScale^2 / 8 must match the trailer size.
const fs = require("fs");
const KFRom = require("./_kfrom");

const file = process.argv[2];
const u8 = new Uint8Array(fs.readFileSync(file));
const pkg = KFRom.parsePackage(u8);
const exp = KFRom.findWorldModel(pkg);
const model = KFRom.readModel(pkg, exp);
const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

// --- geometry facts
console.log("model " + exp.name + " size " + exp.serialSize + "  nodes " + model.nodes.length + " surfs " + model.surfs.length);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
let totalLuxels32 = 0;
model.nodes.forEach((n, i) => {
  if (n.numVertices < 3) return;
  const s = model.surfs[n.iSurf];
  const base = model.points[s.pBase], uA = model.vectors[s.vTextureU], vA = model.vectors[s.vTextureV];
  let uMin = 1e18, uMax = -1e18, vMin = 1e18, vMax = -1e18;
  for (let j = 0; j < n.numVertices; j++) {
    const p = model.points[model.verts[n.iVertPool + j].pVertex];
    const rel = sub(p, base);
    const u = dot(rel, uA), v = dot(rel, vA);
    if (u < uMin) uMin = u; if (u > uMax) uMax = u;
    if (v < vMin) vMin = v; if (v > vMax) vMax = v;
  }
  // texture axes are texels/unit; |axis| gives the scale. Lightmap grid = world extent / ShadowMapScale.
  const lu = Math.hypot(...uA), lv = Math.hypot(...vA);
  const wu = (uMax - uMin) / (lu * lu), wv = (vMax - vMin) / (lv * lv);   // world units
  const lw = Math.floor(wu / 32) + 1, lh = Math.floor(wv / 32) + 1;
  totalLuxels32 += lw * lh;
  console.log("  node" + i + " surf" + n.iSurf + " verts " + n.numVertices +
    "  world " + Math.round(wu) + "x" + Math.round(wv) + "  luxels@32 " + lw + "x" + lh + " = " + lw * lh);
});
console.log("total luxels@32 = " + totalLuxels32 +
  "   -> 1bit " + Math.round(totalLuxels32 / 8 / 1024) + " KB, 8bit " + Math.round(totalLuxels32 / 1024) + " KB, RGB24 " + Math.round(totalLuxels32 * 3 / 1024) + " KB");

const lights = KFRom.readActors(pkg, ["Light", "Spotlight", "Sunlight", "TriggerLight", "KFLight"]);
console.log("light actors: " + lights.length);

// --- trailer walk
let pos = exp.serialOffset + 1 + 25 + 16;
const cidx = () => { let b = u8[pos++]; const neg = (b & 0x80) !== 0; let val = b & 0x3f; if (b & 0x40) { let sh = 6; for (; ;) { b = u8[pos++]; val |= (b & 0x7f) << sh; sh += 7; if (!(b & 0x80)) break; } } return neg ? -val : val; };
const i32 = () => { const v = dv.getInt32(pos, true); pos += 4; return v; };
const f32 = () => { const v = dv.getFloat32(pos, true); pos += 4; return v; };
let n = cidx(); pos += n * 12;
n = cidx(); pos += n * 12;
n = cidx(); for (let i = 0; i < n; i++) { pos += 25; for (let k = 0; k < 7; k++) cidx(); pos += 16 + 3 + 8 + 12; }
n = cidx(); for (let i = 0; i < n; i++) { cidx(); pos += 4; for (let k = 0; k < 6; k++) cidx(); pos += 20; }
n = cidx(); for (let i = 0; i < n; i++) { cidx(); cidx(); }
const t0 = pos, end = exp.serialOffset + exp.serialSize;
console.log("\ntrailer @" + t0 + " .. " + end + "  (" + (end - t0) + " bytes)");
let s = "";
for (let i = 0; i < 160; i++) { if (i % 16 === 0) s += "\n  +" + String(i).padStart(3) + "  "; s += u8[t0 + i].toString(16).padStart(2, "0") + " "; }
console.log("head:" + s);
s = "";
for (let i = 0; i < 160; i++) { if (i % 16 === 0) s += "\n  -" + String(160 - i).padStart(3) + "  "; s += u8[end - 160 + i].toString(16).padStart(2, "0") + " "; }
console.log("tail:" + s);

// hand-guided walk: INT NumSharedSides, cidx Polys, then TArray<FLightMapIndex>
pos = t0;
console.log("\nNumSharedSides = " + i32());
console.log("Polys ref      = " + (() => { const p = pos; const v = cidx(); return v + "  (" + (v > 0 ? pkg.classOf(pkg.exports[v - 1]) + ":" + pkg.exports[v - 1].name : "?") + ")  [" + (pos - p) + "B]"; })());
const nLM = cidx();
console.log("LightMap count = " + nLM + "   (surfs=" + model.surfs.length + ")");
for (let i = 0; i < Math.min(nLM, 8); i++) {
  const DataOffset = i32(), iLightActors = i32();
  const pan = [f32(), f32(), f32()];
  const uS = f32(), vS = f32();
  const uClamp = i32(), vClamp = i32();
  console.log("  LM[" + i + "] off=" + DataOffset + " iLightActors=" + iLightActors +
    " pan=" + pan.map((x) => x.toFixed(0)).join(",") + " scale=" + uS.toFixed(2) + "/" + vS.toFixed(2) +
    " clamp=" + uClamp + "x" + vClamp + "  -> " + (uClamp * vClamp) + " luxels");
}
console.log("pos after LightMap head = " + pos + " (trailer+" + (pos - t0) + ")");
const nLB = cidx();
console.log("LightBits count = " + nLB + "   remaining after = " + (end - pos - nLB));
