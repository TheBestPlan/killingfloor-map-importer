// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Source 2 (CS2) route self-test. The LZ4 block decoder self-checks against hand-rolled vectors; the
// VPK/KV3/meshopt stack is exercised end to end only when a CS2 install is present (KF_CS2 points at a
// map .vpk, or the default Steam path exists), since the real maps are the only faithful fixtures.
// Run: node test/source2.test.js
"use strict";

const fs = require("fs");
const assert = require("assert");

require("../src/source2/lz4").demo();               // asserts internally, prints a line

// Modules must at least load and expose their entry points.
for (const [m, fn] of [["vpk", "Vpk"], ["kv3", "parseKV3"], ["meshopt", "decodeVertexBuffer"], ["resource", "readResource"], ["convert", "convert"]]) {
  const mod = require("../src/source2/" + m);
  assert.ok(typeof mod[fn] === "function" || typeof mod[fn] === "object", "source2/" + m + " exports " + fn);
}
console.log("source2.js: modules load, lz4 self-check passed");

// End-to-end against a real map when one is available.
const candidates = [
  process.env.KF_CS2,
  "D:/Games/SteamLibrary/steamapps/common/Counter-Strike Global Offensive/game/csgo/maps/de_overpass_vanity.vpk",
].filter(Boolean);
const mapVpk = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
if (!mapVpk) {
  console.log("source2.js: no CS2 install found (set KF_CS2 to a map .vpk) - skipped the end-to-end check");
} else {
  const os = require("os"), path = require("path");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "kf-s2-"));
  const { convert } = require("../src/source2/convert");
  const { verify } = require("../src/verify");
  const res = convert({ file: mapVpk, outDir: out, log: () => { } });
  const v = verify(res.out);
  assert.ok(v.ok, "converted " + path.basename(mapVpk) + " must pass verify:\n" + v.report);
  assert.ok(res.stats.triangles > 1000, "expected a non-trivial mesh, got " + res.stats.triangles + " triangles");
  fs.rmSync(out, { recursive: true, force: true });
  console.log("source2.js: " + path.basename(mapVpk) + " -> " + res.stats.triangles + " triangles, verify OK");
}
console.log("source2.test.js: passed");
