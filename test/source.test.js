// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Self-check for the Source BSP route. Converts a stock Counter-Strike: Source map and runs the .rom
// through the independent reader's invariants. Skips cleanly when CS:Source is not installed (CI).
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const { convert, kfRotator } = require("../src/source/convert");
const { verify } = require("../src/verify");

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
