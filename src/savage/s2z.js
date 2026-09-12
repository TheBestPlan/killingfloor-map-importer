// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Savage (.s2z) map archive - a plain ZIP (magic PK\x03\x04) holding one world: a heightmap (.hm), a
// terrain colour map (.cm), splat/attribute maps (.am/.sm/.sm2), object placements (.objpos) and a
// config (.cfg). This reads the central directory and inflates each entry (stored or deflate), which
// is all the terrain route needs.
"use strict";

const fs = require("fs");
const zlib = require("zlib");

function readS2z(file) {
  const buf = fs.readFileSync(file);
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;   // End Of Central Directory
  if (i < 0) throw new Error("not a .s2z/zip (no EOCD): " + file);
  const count = buf.readUInt16LE(i + 10);
  let p = buf.readUInt32LE(i + 16);
  const files = new Map();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;            // central directory header
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("latin1", p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26), lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + csize);
    files.set(name.toLowerCase(), method === 0 ? comp : zlib.inflateRawSync(comp));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

module.exports = { readS2z };
