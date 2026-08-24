// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// How much does a cycler_sprite turn its model? The entity's `angles` is not the answer.
//
// A mapper who wants a prop to block the player wraps it in a hand-built AAATRIGGER or CLIP brush,
// and that brush is the only record in the .bsp of how the prop actually looks in the running game.
// Comparing the brush's footprint against the model's own tells whether the engine drew the model
// at the declared yaw or a quarter turn past it. The box resolves the angle modulo 180, which is
// exactly the ambiguity that separates the two answers.
//
// Run: node scripts/propyaw.js <cstrike dir> [<map.bsp> ...]
// With no map given, every .bsp under <cstrike>/maps is measured.
"use strict";

const fs = require("fs");
const path = require("path");
const bsp = require("../src/goldsrc/bsp");
const mdl = require("../src/goldsrc/mdl");

const cstrike = process.argv[2];
if (!cstrike) { console.error("usage: node scripts/propyaw.js <cstrike dir> [map.bsp ...]"); process.exit(2); }
const maps = process.argv.length > 3 ? process.argv.slice(3)
  : fs.readdirSync(path.join(cstrike, "maps")).filter((n) => /\.bsp$/i.test(n)).map((n) => path.join(cstrike, "maps", n));

const cache = new Map();
function footprint(file) {
  if (!cache.has(file)) {
    const m = fs.existsSync(file) ? mdl.load(file) : null;
    let r = null;
    if (m) {
      const lo = [1e9, 1e9], hi = [-1e9, -1e9];
      for (const p of m.parts) for (const t of p.tris) for (const v of t)
        for (let k = 0; k < 2; k++) { if (v.pos[k] < lo[k]) lo[k] = v.pos[k]; if (v.pos[k] > hi[k]) hi[k] = v.pos[k]; }
      r = { x: hi[0] - lo[0], y: hi[1] - lo[1] };
    }
    cache.set(file, r);
  }
  return cache.get(file);
}

// Every axis-aligned box a face of an invisible tool texture belongs to, by its XY extent.
function clipBoxes(map) {
  const out = [];
  for (const f of map.faces) {
    const tex = ((map.miptex[map.texinfo[f.texinfo].miptex] || {}).name || "").toUpperCase();
    if (tex !== "AAATRIGGER" && tex !== "CLIP") continue;
    const vs = map.faceVertices(f);
    if (!vs.length) continue;
    const lo = [1e9, 1e9], hi = [-1e9, -1e9];
    for (const v of vs) for (let k = 0; k < 2; k++) { if (v[k] < lo[k]) lo[k] = v[k]; if (v[k] > hi[k]) hi[k] = v[k]; }
    if (hi[0] - lo[0] < 1 || hi[1] - lo[1] < 1) continue;         // a side of the box, not its plan
    out.push({ c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2], x: hi[0] - lo[0], y: hi[1] - lo[1] });
  }
  return out;
}

let asDeclared = 0, quarterTurn = 0;
for (const file of maps) {
  let map;
  try { map = bsp.load(file); } catch (e) { continue; }
  if (!map) continue;
  const boxes = clipBoxes(map);
  if (!boxes.length) continue;

  for (const e of map.entities) {
    if (!/\.mdl$/i.test(e.model || "") || /^\*/.test(e.model)) continue;
    const yaw = parseFloat((e.angles || "0 0 0").split(/\s+/)[1]) || 0;
    if (Math.abs(((yaw % 90) + 90) % 90) > 3) continue;            // only right angles are readable
    const fp = footprint(path.join(cstrike, e.model.replace(/\\/g, "/")));
    if (!fp || Math.max(fp.x, fp.y) < 1.5 * Math.min(fp.x, fp.y)) continue;   // a square proves nothing

    const org = (e.origin || "").split(/\s+/).map(Number);
    let box = null;
    for (const b of boxes) {
      const d = Math.hypot(b.c[0] - org[0], b.c[1] - org[1]);
      if (d < 60 && (!box || d < box.d)) box = Object.assign({ d }, b);
    }
    if (!box || Math.max(box.x, box.y) < 1.5 * Math.min(box.x, box.y)) continue;

    const boxIsTurned = Math.abs(box.x - fp.y) + Math.abs(box.y - fp.x) < Math.abs(box.x - fp.x) + Math.abs(box.y - fp.y);
    const yawIsTurned = Math.round(Math.abs(yaw) / 90) % 2 === 1;
    const declared = boxIsTurned === yawIsTurned;
    if (declared) asDeclared++; else quarterTurn++;
    console.log([path.basename(file), path.basename(e.model), "yaw " + yaw,
      "model " + fp.x.toFixed(0) + "x" + fp.y.toFixed(0),
      "clip " + box.x.toFixed(0) + "x" + box.y.toFixed(0),
      declared ? "as declared" : "quarter turn past"].join("  "));
  }
}

console.log("\ndrawn at the declared yaw: " + asDeclared + "   drawn a quarter turn past it: " + quarterTurn);
