// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// GTA III / Vice City route self-test. The RenderWare parsers (img/dff/placement) are exercised end to
// end only when a GTA install is present (KF_GTA3 / KF_VC point at the game root), since the real game
// data is the only faithful fixture. Without one, this just checks the modules load.
// Run: node test/gta.test.js
"use strict";

const fs = require("fs");
const assert = require("assert");

for (const [m, fn] of [["img", "Img"], ["dff", "readDff"], ["placement", "readIde"], ["convert", "convert"]]) {
  const mod = require("../src/gta/" + m);
  assert.ok(typeof mod[fn] === "function", "gta/" + m + " exports " + fn);
}
console.log("gta.js: modules load");

const roots = [
  [process.env.KF_GTA3, "gta3"],
  [process.env.KF_VC, "vc"],
  ["D:/games/Grand_Theft_Auto/Grand_Theft_Auto_III_INSTALLED_GTAC_patch", "gta3"],
].filter(([p]) => p);
const hit = roots.find(([p]) => { try { return fs.statSync(require("path").join(p, "models", "gta3.img")).isFile(); } catch (e) { return false; } });
if (!hit) {
  console.log("gta.js: no GTA install found (set KF_GTA3 / KF_VC to a game root) - skipped the end-to-end check");
} else {
  const os = require("os"), path = require("path");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "kf-gta-"));
  const { convert } = require("../src/gta/convert");
  const { verify } = require("../src/verify");
  const res = convert({ clientDir: hit[0], game: hit[1], outDir: out, log: () => { } });
  const v = verify(res.out);
  assert.ok(v.ok, "converted " + hit[1] + " must pass verify:\n" + v.report);
  assert.ok(res.stats.triangles > 10000, "expected a populated district, got " + res.stats.triangles + " triangles");
  fs.rmSync(out, { recursive: true, force: true });
  console.log("gta.js: " + hit[1] + " district -> " + res.stats.triangles + " triangles, verify OK");
}
console.log("gta.test.js: passed");
