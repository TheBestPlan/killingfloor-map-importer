// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Savage (.s2z) route self-test. The s2z/terrain reader is exercised end to end only when a Savage
// install is present (KF_SAVAGE points at a map .s2z, or the default path exists).
// Run: node test/savage.test.js
"use strict";

const fs = require("fs");
const assert = require("assert");

assert.ok(typeof require("../src/savage/s2z").readS2z === "function", "savage/s2z exports readS2z");
assert.ok(typeof require("../src/savage/convert").convert === "function", "savage/convert exports convert");
console.log("savage.js: modules load");

const candidates = [process.env.KF_SAVAGE, "D:/games-4-convert/Savage3T_2006/game/world/2towers.s2z"].filter(Boolean);
const map = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
if (!map) {
  console.log("savage.js: no Savage install found (set KF_SAVAGE to a map .s2z) - skipped the end-to-end check");
} else {
  const os = require("os"), path = require("path");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "kf-sv-"));
  const { convert } = require("../src/savage/convert");
  const { verify } = require("../src/verify");
  const res = convert({ file: map, outDir: out, log: () => { } });
  const v = verify(res.out);
  assert.ok(v.ok, "converted " + path.basename(map) + " must pass verify:\n" + v.report);
  assert.ok(res.stats.triangles > 1000, "expected a terrain mesh, got " + res.stats.triangles + " triangles");
  fs.rmSync(out, { recursive: true, force: true });
  console.log("savage.js: " + path.basename(map) + " -> " + res.stats.triangles + " triangles, verify OK");
}
console.log("savage.test.js: passed");
