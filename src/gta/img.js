// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// GTA III / Vice City IMG archive (RenderWare VER1: a separate `<name>.dir` index + `<name>.img` blob).
// The .dir is a flat table of 32-byte entries { u32 offsetSectors, u32 sizeSectors, char[24] name };
// each file's bytes live at offsetSectors*2048 in the .img for sizeSectors*2048 bytes (zero-padded to
// the sector). Names are looked up case-insensitively without their extension so an .ide's "ind_land101"
// finds "ind_land101.dff". (VER2 - San Andreas - embeds the dir in the img with a "VER2" magic; GTA III
// and Vice City are VER1, which is all this handles.)
"use strict";

const fs = require("fs");
const path = require("path");

const SECTOR = 2048;

class Img {
  constructor(imgFile) {
    this.imgFile = imgFile;
    const dirFile = imgFile.replace(/\.img$/i, ".dir");
    const dir = fs.readFileSync(dirFile);
    this.buf = fs.readFileSync(imgFile);
    this.entries = new Map();          // lowercased name (no ext) -> { offset, size, name }
    for (let p = 0; p + 32 <= dir.length; p += 32) {
      const offset = dir.readUInt32LE(p) * SECTOR;
      const size = dir.readUInt32LE(p + 4) * SECTOR;
      let e = p + 8; while (e < p + 32 && dir[e] !== 0) e++;
      const name = dir.toString("latin1", p + 8, e);
      if (name) this.entries.set(name.toLowerCase().replace(/\.[^.]+$/, ""), { offset, size, name });
    }
  }

  has(name) { return this.entries.has(String(name).toLowerCase().replace(/\.[^.]+$/, "")); }
  read(name) {
    const e = this.entries.get(String(name).toLowerCase().replace(/\.[^.]+$/, ""));
    if (!e) return null;
    return this.buf.subarray(e.offset, e.offset + e.size);
  }
}

module.exports = { Img };
