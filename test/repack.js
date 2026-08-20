// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Rebuilds an existing .rom with this tool's package writer: same names, same imports, same
// exports in the same order, every object's bytes copied verbatim except the world UModel, which is
// re-serialized from the parsed structure. If the result is byte-identical to the input then the
// writer and the model serializer are both proven, and any crash must come from generated content.
//
//   node test/repack.js <in.rom> [out.rom]
"use strict";

const fs = require("fs");
const path = require("path");
const R = require("../src/unreal/read");
const { Package, RF } = require("../src/unreal/package");
const { Writer } = require("../src/unreal/writer");
const { writeModel } = require("../src/unreal/model");

const inFile = process.argv[2];
const outFile = process.argv[3] || inFile.replace(/\.rom$/i, "-repack.rom");

const src = R.load(inFile);
const worldExp = R.findWorldModel(src);
const model = worldExp ? R.readModel(src, worldExp) : null;

const pkg = new Package({ guid: Buffer.from(src.header.guid) });
// Seed the name table in the original order so every stored name index stays valid.
for (const n of src.names) pkg.names.add(n);
for (const im of src.imports) pkg._import(im.classPackage, im.className, im.packageIndex, im.name);

src.exports.forEach((e) => {
  const isWorld = worldExp && e.serialOffset === worldExp.serialOffset;
  pkg.addExport({
    classRef: e.classIndex, superRef: e.superIndex, outer: e.packageIndex,
    name: e.name, flags: e.objectFlags,
    serialize: (p) => {
      if (isWorld && model) return writeModel(p, model);
      const w = new Writer(Math.max(16, e.serialSize));
      if (e.serialSize > 0) w.bytes(src.buf.subarray(e.serialOffset, e.serialOffset + e.serialSize));
      return w;
    },
  });
});

const out = pkg.build();
fs.writeFileSync(outFile, out);

const orig = src.buf;
let diff = 0, firstDiff = -1;
for (let i = 0; i < Math.min(out.length, orig.length); i++) {
  if (out[i] !== orig[i]) { diff++; if (firstDiff < 0) firstDiff = i; }
}
console.log(path.basename(inFile) + " -> " + path.basename(outFile));
console.log("  size " + orig.length + " -> " + out.length + (out.length === orig.length ? "  (same)" : "  DIFFERENT"));
console.log("  differing bytes: " + diff + (firstDiff >= 0 ? "  first @" + firstDiff : ""));

// The name-flag word is the one field this writer normalises, so report the diff with those excluded.
const nameFlagPositions = new Set();
{
  const r = new R.Rd(out, 0);
  r.skip(4 + 2 + 2 + 4 + 4);
  const nameOffset = out.readUInt32LE(16);
  r.pos = nameOffset;
  for (let i = 0; i < src.names.length; i++) {
    const n = r.cidx(); r.skip(n);
    for (let k = 0; k < 4; k++) nameFlagPositions.add(r.pos + k);
    r.skip(4);
  }
}
let realDiff = 0, firstReal = -1;
for (let i = 0; i < Math.min(out.length, orig.length); i++) {
  if (out[i] !== orig[i] && !nameFlagPositions.has(i)) { realDiff++; if (firstReal < 0) firstReal = i; }
}
console.log("  differing bytes ignoring name flags: " + realDiff + (firstReal >= 0 ? "  first @" + firstReal : ""));
process.exit(realDiff === 0 && out.length === orig.length ? 0 : 1);
