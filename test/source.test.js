// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Self-check for the Source BSP route. Converts a stock Counter-Strike: Source map and runs the .rom
// through the independent reader's invariants. Skips cleanly when CS:Source is not installed (CI).
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const { convert, kfRotator, splitLargeProp } = require("../src/source/convert");
const { verify } = require("../src/verify");

// A prop over the 16-bit vertex limit must be SPLIT into <=65000-vertex parts, not dropped, with every
// triangle preserved and every index in range. Synthetic: 70000 vertices, two materials.
{
  const N = 70000;
  const verts = Array.from({ length: N }, (_, i) => ({ pos: [i % 500, (i / 500) | 0, (i % 7)], normal: [0, 0, 1], uv: [0, 0] }));
  const triOf = (base, n) => { const idx = []; for (let i = 0; i < n; i++) { const a = (base + i) % N, b = (base + i + 1) % N, c = (base + i + 2) % N; idx.push(a, b, c); } return idx; };
  const pm = { verts, submeshes: [{ indices: triOf(0, 30000), material: 0 }, { indices: triOf(30000, 30000), material: 1 }] };
  const parts = splitLargeProp(pm, 1);
  assert.ok(parts.length >= 2, "an oversized prop splits into multiple parts (" + parts.length + ")");
  let faces = 0;
  for (const p of parts) {
    assert.ok(p.vertices.length <= 65000, "each part <= 65000 vertices (" + p.vertices.length + ")");
    for (const i of p.indices) assert.ok(i >= 0 && i < p.vertices.length, "index in range");
    for (const s of p.sections) faces += s.numFaces;
    assert.strictEqual(p.indices.length, p.sections.reduce((n, s) => n + s.numFaces * 3, 0), "sections cover every index");
  }
  assert.strictEqual(faces, 60000, "every triangle preserved across the split (" + faces + "/60000)");
  console.log("  splitLargeProp: 70000-vertex prop -> " + parts.length + " parts, all 60000 triangles kept");
}

// The prop rotator must agree with the player-start convention: a yaw-only Source angle becomes -yaw
// in KF (the Y mirror), with pitch and roll zero. Getting this wrong only shows on oriented props
// (crates, railings) - symmetric ones (trees, rocks) hide it - so it is asserted, not eyeballed.
{
  const deg = (u16) => ((u16 > 32768 ? u16 - 65536 : u16) / 65536 * 360);
  const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);   // shortest arc, wraps at +-180
  for (const y of [0, 45, 90, 180, -90]) {
    const r = kfRotator([0, y, 0]);
    assert.ok(angDiff(deg(r[1]), -y) < 0.5, "yaw " + y + " -> KF " + deg(r[1]) + ", want " + (-y));
    assert.ok(Math.abs(deg(r[0])) < 0.5 && Math.abs(deg(r[2])) < 0.5, "yaw-only keeps pitch/roll zero");
  }
  console.log("  kfRotator: yaw-only -> -yaw, pitch/roll zero (matches player-start convention)");
}

const CANDIDATES = [
  process.env.KF_SOURCE_MAP,
  "D:/games/SteamLibrary/steamapps/common/Counter-Strike Source/cstrike/maps/cs_italy.bsp",
  "C:/Program Files (x86)/Steam/steamapps/common/Counter-Strike Source/cstrike/maps/cs_italy.bsp",
].filter(Boolean);

const map = CANDIDATES.find((f) => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } });
if (!map) {
  console.log("source.test.js: SKIP (no Counter-Strike: Source map found; set KF_SOURCE_MAP)");
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kf-source-"));
const res = convert({ file: map, outDir: dir, log: () => { } });
assert.ok(res.meshes >= 1, "at least one mesh from " + path.basename(map));
assert.ok(fs.existsSync(res.out), ".rom written");
const v = verify(res.out);
assert.ok(v.ok, "verify invariants:\n" + v.report);
console.log("  Source " + path.basename(map) + " -> " + path.basename(res.out) + ": " + res.meshes + " mesh, verify OK");
fs.rmSync(dir, { recursive: true, force: true });
console.log("source.test.js: passed");
