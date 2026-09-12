// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Vampire: The Masquerade - Redemption route self-test. The Nod .nil reader is exercised end to end
// only when the game data is present (KF_VTMR points at Levels.nob or a .nil, or the default path).
// Run: node test/vtmr.test.js
"use strict";

const fs = require("fs");
const assert = require("assert");

assert.ok(typeof require("../src/vtmr/nil").readNil === "function", "vtmr/nil exports readNil");
assert.ok(typeof require("../src/vtmr/convert").convert === "function", "vtmr/convert exports convert");
console.log("vtmr.js: modules load");

const candidates = [
  process.env.KF_VTMR,
  "D:/games-4-convert/interviju_s_vampirami/Vampire_The_Masquerade_Redemption_GF_2CD/VAMPIRE_CD2/Setup/Levels.nob",
].filter(Boolean);
const src = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
if (!src) {
  console.log("vtmr.js: no VtM:R data found (set KF_VTMR to Levels.nob or a .nil) - skipped the end-to-end check");
} else {
  const os = require("os"), path = require("path");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "kf-vtmr-"));
  const { convert } = require("../src/vtmr/convert");
  const { verify } = require("../src/verify");
  const r = convert({ file: src, level: "l1_brot", outDir: out, log: () => { } });
  const v = verify(r.out);
  assert.ok(v.ok, "converted a VtM:R level must pass verify:\n" + v.report);
  assert.ok(r.stats.triangles > 2000, "expected sector geometry, got " + r.stats.triangles + " triangles");
  fs.rmSync(out, { recursive: true, force: true });
  console.log("vtmr.js: " + path.basename(r.out) + " -> " + r.stats.triangles + " triangles, verify OK");
}
console.log("vtmr.test.js: passed");
