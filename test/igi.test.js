// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Project IGI route self-test. The ILFF/.mef parsers are exercised end to end only when an IGI install
// is present (KF_IGI points at a level models .res, or the default path exists).
// Run: node test/igi.test.js
"use strict";

const fs = require("fs");
const assert = require("assert");

assert.ok(typeof require("../src/igi/ilff").readResPack === "function", "igi/ilff exports readResPack");
assert.ok(typeof require("../src/igi/mef").readMef === "function", "igi/mef exports readMef");
assert.ok(typeof require("../src/igi/convert").convert === "function", "igi/convert exports convert");
console.log("igi.js: modules load");

const candidates = [
  process.env.KF_IGI,
  "D:/games-4-convert/Project-IGI-Im-Going-In/Project_IGI_RU_INSTALL/pc/missions/location0/level2/models/level2.res",
].filter(Boolean);
const res = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
if (!res) {
  console.log("igi.js: no IGI install found (set KF_IGI to a level models .res) - skipped the end-to-end check");
} else {
  const os = require("os"), path = require("path");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "kf-igi-"));
  const { convert } = require("../src/igi/convert");
  const { verify } = require("../src/verify");
  const r = convert({ file: res, outDir: out, log: () => { } });
  const v = verify(r.out);
  assert.ok(v.ok, "converted " + path.basename(res) + " must pass verify:\n" + v.report);
  assert.ok(r.stats.triangles > 5000, "expected a populated level, got " + r.stats.triangles + " triangles");
  fs.rmSync(out, { recursive: true, force: true });
  console.log("igi.js: " + path.basename(res) + " -> " + r.stats.triangles + " triangles, verify OK");
}
console.log("igi.test.js: passed");
