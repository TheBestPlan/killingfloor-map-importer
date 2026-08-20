// Self-check for the Source BSP route. Converts a stock Counter-Strike: Source map and runs the .rom
// through the independent reader's invariants. Skips cleanly when CS:Source is not installed (CI).
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const { convert } = require("../src/source/convert");
const { verify } = require("../src/verify");

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
